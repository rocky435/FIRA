/**
 * PUT /api/venues/:id/blocked-days - an owner blocks whole days booked outside
 * FIRA. It must only ever add or remove the owner's own 'busy' slots: the days
 * bookings and events hold are never touched, and a day a guest or event holds
 * cannot be blocked. Blocked days then refuse bookings and events.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.REDIS_HOST;

const venueRoutes = require('../routes/venue');
const Venue = require('../models/Venue');
const venueService = require('../services/venueService');

const app = express();
app.use(express.json());
app.use('/api/venues', venueRoutes);

const db = () => mongoose.connection.db!;
const tokenFor = (id: any) => jwt.sign({ userId: String(id) }, process.env.JWT_SECRET as string);
const dayFromNow = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let ownerId: mongoose.Types.ObjectId;
let venueId: mongoose.Types.ObjectId;
const put = (body: any, who = ownerId) => request(app)
    .put(`/api/venues/${venueId}/blocked-days`)
    .set('Authorization', `Bearer ${tokenFor(who)}`)
    .send(body);

async function user(role: string) {
    const _id = new mongoose.Types.ObjectId();
    await db().collection('users').insertOne({ _id, name: role, email: `${_id}@x.test`, role, roles: [role] });
    return _id;
}

beforeEach(async () => {
    ownerId = await user('venue_owner');
    venueId = new mongoose.Types.ObjectId();
    await db().collection('venues').insertOne({
        _id: venueId, name: 'Lotus Hall', owner: ownerId, status: 'approved', isActive: true,
        pricing: { basePrice: 1000 },
        blockedDates: [{ date: dayFromNow(9), slots: [{ startTime: '10:00', endTime: '18:00', type: 'booked', booking: new mongoose.Types.ObjectId() }] }],
    });
});

describe('PUT /venues/:id/blocked-days', () => {
    it('blocks and unblocks whole days, leaving booking holds alone', async () => {
        const res = await put({ block: [dayFromNow(3), dayFromNow(4)] });
        expect(res.status).toBe(200);
        const keys = res.body.blockedDates.map((b: any) => b.date);
        expect(keys).toEqual(expect.arrayContaining([dayFromNow(3), dayFromNow(4), dayFromNow(9)]));

        // Blocking again adds nothing twice.
        await put({ block: [dayFromNow(3)] });
        let venue = await Venue.findById(venueId).lean();
        expect(venue.blockedDates.find((b: any) => b.date === dayFromNow(3)).slots).toHaveLength(1);

        const un = await put({ unblock: [dayFromNow(3), dayFromNow(9)] });
        expect(un.status).toBe(200);
        venue = await Venue.findById(venueId).lean();
        expect(venue.blockedDates.find((b: any) => b.date === dayFromNow(3))).toBeUndefined();
        // Unblocking never removes what a booking holds.
        expect(venue.blockedDates.find((b: any) => b.date === dayFromNow(9)).slots[0].type).toBe('booked');
    });

    it('refuses a day a guest has requested, naming it', async () => {
        await db().collection('bookings').insertOne({
            user: new mongoose.Types.ObjectId(), venue: venueId, status: 'pending', paymentStatus: 'pending',
            bookingDate: new Date(`${dayFromNow(5)}T00:00:00Z`), startTime: '10:00', endTime: '18:00', totalAmount: 1000,
        });
        const res = await put({ block: [dayFromNow(5), dayFromNow(6)] });
        expect(res.status).toBe(409);
        expect(res.body.days).toEqual([dayFromNow(5)]);
        const venue = await Venue.findById(venueId).lean();
        expect(venue.blockedDates.find((b: any) => b.date === dayFromNow(6))).toBeUndefined();
    });

    it("refuses someone who doesn't own the venue, and past or malformed days", async () => {
        expect((await put({ block: [dayFromNow(3)] }, await user('venue_owner'))).status).toBe(403);
        expect((await put({ block: [dayFromNow(-2)] })).status).toBe(400);
        expect((await put({ block: ['12/11/2026'] })).status).toBe(400);
        expect((await put({})).status).toBe(400);
    });

    it('a blocked day then refuses an event at the venue', async () => {
        await put({ block: [dayFromNow(3)] });
        const eventService = require('../services/eventService');
        const start = new Date(`${dayFromNow(3)}T18:00:00`);
        const end = new Date(`${dayFromNow(3)}T22:00:00`);
        await expect(eventService.createEvent({
            name: 'Night', description: 'x', organizer: await user('user'), venue: venueId,
            startDateTime: start.toISOString(), endDateTime: end.toISOString(), ticketTiers: [{ name: 'GA', price: 0, maxQuantity: 10 }],
        })).rejects.toThrow(/unavailable/);
    });
});

describe('general venue update', () => {
    it('can no longer overwrite blockedDates', () => {
        const safe = venueService.stripProtectedFields({ name: 'x', blockedDates: [], daySlots: [] });
        expect(safe).toEqual({ name: 'x' });
    });
});
