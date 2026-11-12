/**
 * Blocking and unblocking listings, and the creator page's full history.
 *
 * - Venue: the admin's Block stores 'blocked', which the Venue schema did not
 *   allow ('suspended' only), so a blocked venue failed its own validation.
 * - Event: there was no way back from 'blocked'. Unblock is admin-only, returns
 *   the event to the status it had when blocked, and tells the organiser.
 * - Creator page: events and totals were cut to the latest 10.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.REDIS_HOST;

const adminService = require('../services/adminService');
const Venue = require('../models/Venue');
const Event = require('../models/Event');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const adminRoutes = require('../routes/admin');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const db = () => mongoose.connection.db!;
const oid = () => new mongoose.Types.ObjectId();
const inDays = (n: number) => new Date(Date.now() + n * 86400000);

let admin: mongoose.Types.ObjectId;
let organizer: mongoose.Types.ObjectId;
const tokens = new Map<string, string>();
const bearer = (id: mongoose.Types.ObjectId) => `Bearer ${tokens.get(String(id))}`;

async function makeUser(name: string, role = 'user', extra: Record<string, unknown> = {}) {
    const _id = oid();
    await db().collection('users').insertOne({
        _id, name, email: `${name}-${_id}@x.test`, role, roles: [role], ...extra,
    });
    tokens.set(String(_id), jwt.sign({ userId: String(_id), role }, process.env.JWT_SECRET!));
    return _id;
}

async function makeEvent(overrides: Record<string, unknown> = {}) {
    const _id = oid();
    await db().collection('events').insertOne({
        _id, organizer, name: 'Night Market', description: 'd',
        startDateTime: inDays(10), endDateTime: inDays(10.2), maxAttendees: 100,
        customVenue: { isCustom: true, name: 'Lawn', city: 'Pune' },
        status: 'approved',
        adminApproval: { status: 'approved' }, venueApproval: { status: 'approved' },
        ...overrides,
    });
    return _id;
}

beforeEach(async () => {
    admin = await makeUser('admin', 'admin', { adminRole: 'admin' });
    organizer = await makeUser('organizer');
});

describe('venue block', () => {
    it('a blocked venue is a valid venue', async () => {
        const owner = await makeUser('owner', 'venue_owner');
        const venueId = oid();
        await db().collection('venues').insertOne({
            _id: venueId, owner, name: 'Lotus Hall', description: 'd', status: 'approved',
            capacity: { min: 1, max: 100 }, address: { city: 'Pune' },
        });

        await adminService.updateVenueStatus(String(venueId), 'blocked', admin);

        const venue = await Venue.findById(venueId);
        expect(venue.status).toBe('blocked');
        // Full validation of the stored document: failed on the status enum before.
        const err = venue.validateSync(['status']);
        expect(err).toBeUndefined();
    });
});

describe('event unblock', () => {
    it('block tells the organiser; unblock restores the earlier status and records it', async () => {
        const eventId = await makeEvent({ status: 'approved' });

        const blocked = await request(app).put(`/api/admin/events/${eventId}/status`)
            .set('Authorization', bearer(admin)).send({ status: 'blocked' });
        expect(blocked.status).toBe(200);
        expect(blocked.body.status).toBe('blocked');

        const res = await request(app).post(`/api/admin/events/${eventId}/unblock`).set('Authorization', bearer(admin));
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('approved');

        const trail = await AuditLog.find({ entityId: eventId }).sort({ timestamp: 1 }).lean();
        expect(trail.map((e: any) => e.action)).toEqual(['block', 'unblock']);
        expect(trail[1].metadata).toMatchObject({ from: 'blocked', to: 'approved' });
        expect(String(trail[1].adminUser)).toBe(String(admin));

        const notes = await Notification.find({ user: organizer }).sort({ createdAt: 1 }).lean();
        expect(notes.map((n: any) => n.title)).toEqual(['Your event was blocked', 'Your event was unblocked']);
        expect(notes[0].message).toMatch(/contact FIRA support/);
    });

    it('restores a blocked pending event to pending, not to live', async () => {
        const eventId = await makeEvent({ status: 'pending', adminApproval: { status: 'pending' } });
        await adminService.updateEventStatus(String(eventId), 'blocked', admin);
        // A second block of an already-blocked event must not erase where it came from.
        await adminService.updateEventStatus(String(eventId), 'blocked', admin);

        const event = await adminService.unblockEvent(String(eventId), admin);
        expect(event.status).toBe('pending');
    });

    it('without a recorded block, rebuilds the status from the approvals', async () => {
        const live = await makeEvent({ status: 'blocked' });
        const inReview = await makeEvent({ status: 'blocked', venueApproval: { status: 'pending' } });

        expect((await adminService.unblockEvent(String(live), admin)).status).toBe('approved');
        expect((await adminService.unblockEvent(String(inReview), admin)).status).toBe('pending');
    });

    it('refuses an event that is not blocked', async () => {
        const eventId = await makeEvent({ status: 'approved' });
        const res = await request(app).post(`/api/admin/events/${eventId}/unblock`).set('Authorization', bearer(admin));
        expect(res.status).toBe(400);
        expect((await Event.findById(eventId).lean()).status).toBe('approved');
    });

    it('the organiser cannot unblock their own event', async () => {
        const eventId = await makeEvent({ status: 'blocked' });
        const res = await request(app).post(`/api/admin/events/${eventId}/unblock`).set('Authorization', bearer(organizer));
        expect([401, 403]).toContain(res.status);
        expect((await Event.findById(eventId).lean()).status).toBe('blocked');
    });
});

describe('creator page history', () => {
    it('returns every event and totals over all of them, not the latest 10', async () => {
        const brandId = oid();
        await db().collection('brandprofiles').insertOne({
            _id: brandId, user: organizer, name: 'Bassline', type: 'dj', status: 'approved',
            createdAt: new Date(), updatedAt: new Date(),
        });
        // 12 completed events, oldest first, ₹100 of tickets each.
        for (let i = 0; i < 12; i++) {
            const eventId = await makeEvent({ name: `Gig ${i}`, status: 'completed', startDateTime: inDays(-100 + i), endDateTime: inDays(-99.9 + i) });
            await db().collection('tickets').insertOne({ _id: oid(), ticketId: `T-${i}`, event: eventId, user: oid(), price: 100, quantity: 1, status: 'active' });
        }
        // Not "hosted": rejected, and one removed.
        await makeEvent({ name: 'Turned down', status: 'rejected' });
        await makeEvent({ name: 'Taken down', status: 'approved', isDeleted: true });

        const brand = await adminService.getBrandById(String(brandId));
        expect(brand.events).toHaveLength(14);
        expect(brand.stats.totalEvents).toBe(14);
        expect(brand.stats.eventsHosted).toBe(12);
        expect(brand.stats.totalRevenue).toBe(1200);
        // The oldest gig is there - the cap dropped it before.
        expect(brand.events.map((e: any) => e.name)).toContain('Gig 0');
    });
});
