/**
 * An admin approving or rejecting an event is recorded in the audit trail, with
 * who did it, what it was before, the rejection reason, and whether it went live.
 * Venues, creators, refunds and ID checks were recorded; event decisions were not.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.REDIS_HOST;

const AuditLog = require('../models/AuditLog');
const Event = require('../models/Event');

const db = () => mongoose.connection.db!;
const oid = () => new mongoose.Types.ObjectId();

async function setup() {
    const admin = oid();
    const organizer = oid();
    await db().collection('users').insertMany([
        { _id: admin, name: 'Ravi Admin', email: `a-${admin}@x.test`, role: 'admin', roles: ['admin'], adminRole: 'admin' },
        { _id: organizer, name: 'Org', email: `o-${organizer}@x.test`, role: 'user', roles: ['user'] },
    ]);
    const app = express();
    app.use(express.json());
    const routes = await import('../routes/event');
    app.use('/events', (routes as any).default || routes);
    const token = jwt.sign({ userId: String(admin), role: 'admin' }, process.env.JWT_SECRET!);
    // A custom-venue event: no venue booking to pay, so approval makes it live.
    const makeEvent = async (name: string) => (await Event.create({
        organizer, name, description: 'd', maxAttendees: 50, status: 'pending',
        startDateTime: new Date(Date.now() + 10 * 864e5), endDateTime: new Date(Date.now() + 10.2 * 864e5),
        customVenue: { isCustom: true, name: 'Lawn', city: 'Pune' },
        venueApproval: { status: 'approved' }, adminApproval: { status: 'pending' },
    }))._id;
    return { app, admin, token, makeEvent };
}

describe('event approve / reject in the audit trail', () => {
    it('records an approval, by whom, and that it went live', async () => {
        const { app, admin, token, makeEvent } = await setup();
        const id = await makeEvent('Garden Gig');

        const res = await request(app).post(`/events/${id}/admin-approve`).set('Authorization', `Bearer ${token}`).send({ status: 'approved' });
        expect(res.status).toBe(200);

        const entries = await AuditLog.find({ entityType: 'event', entityId: id }).lean();
        expect(entries).toHaveLength(1);
        expect(entries[0].action).toBe('approve');
        expect(String(entries[0].adminUser)).toBe(String(admin));
        expect(entries[0].metadata).toMatchObject({
            name: 'Garden Gig', field: 'adminApproval', from: 'pending', to: 'approved', wentLive: true, statusFrom: 'pending', statusTo: 'approved',
        });
    });

    it('records a rejection with its reason', async () => {
        const { app, token, makeEvent } = await setup();
        const id = await makeEvent('Rooftop Rave');

        const res = await request(app).post(`/events/${id}/admin-approve`).set('Authorization', `Bearer ${token}`)
            .send({ status: 'rejected', rejectionReason: 'Missing venue address' });
        expect(res.status).toBe(200);

        const entry = await AuditLog.findOne({ entityType: 'event', entityId: id }).lean();
        expect(entry.action).toBe('reject');
        expect(entry.metadata).toMatchObject({ to: 'rejected', reason: 'Missing venue address', statusTo: 'rejected' });
    });

    it('a refused request records nothing', async () => {
        const { app, token, makeEvent } = await setup();
        const id = await makeEvent('Bad Request');
        const res = await request(app).post(`/events/${id}/admin-approve`).set('Authorization', `Bearer ${token}`).send({ status: 'maybe' });
        expect(res.status).toBe(400);
        expect(await AuditLog.countDocuments({ entityId: id })).toBe(0);
    });
});
