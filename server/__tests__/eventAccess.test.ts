/**
 * Access control and trust boundaries on the event routes.
 *
 * - PUT/DELETE/cancel only required *a* signed-in user, so anyone could edit,
 *   delete or cancel (and mass-refund) any event.
 * - Create and update took the raw body, so an event could be created already
 *   approved, at 0% platform fee, or have its organizer swapped.
 * - Editing tiers reset soldCount to 0, letting a tier sell out twice.
 * - admin-approve had no auth (adminId came from the body), venue-approve trusted
 *   venueOwnerId from the body, and access requests could be approved by anyone.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.REDIS_HOST;

const Event = require('../models/Event');
const PrivateEventAccess = require('../models/PrivateEventAccess');

let app: express.Express;
let organizer: string, stranger: string, venueOwner: string, admin: string;
let venueId: mongoose.Types.ObjectId;
const tokens: Record<string, string> = {};

async function makeUser(name: string, role = 'user') {
    const _id = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('users').insertOne({
        _id, name, email: `${name}@x.test`, role, roles: [role], isVerified: false,
    });
    const id = _id.toString();
    tokens[id] = jwt.sign({ userId: id, role }, process.env.JWT_SECRET!);
    return id;
}

const bearer = (id: string) => `Bearer ${tokens[id]}`;
const inDays = (n: number) => new Date(Date.now() + n * 86400000);

async function makeEvent(overrides: Record<string, any> = {}) {
    return Event.create({
        organizer, venue: venueId, name: 'Party', description: 'd',
        startDateTime: inDays(10), endDateTime: inDays(10.2), maxAttendees: 100,
        status: 'pending', ...overrides,
    });
}

beforeEach(async () => {
    organizer = await makeUser('organizer');
    stranger = await makeUser('stranger');
    venueOwner = await makeUser('owner', 'venue_owner');
    admin = await makeUser('admin', 'admin');
    venueId = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('venues').insertOne({
        _id: venueId, name: 'V', owner: new mongoose.Types.ObjectId(venueOwner),
    });

    app = express();
    app.use(express.json());
    const routes = await import('../routes/event');
    app.use('/events', (routes as any).default || routes);
});

describe('POST /events', () => {
    it('ignores client-supplied approval state, fee, featured flag and sales counters', async () => {
        const res = await request(app)
            .post('/events')
            .set('Authorization', bearer(organizer))
            .send({
                name: 'Sneaky', description: 'd', startDateTime: inDays(5), endDateTime: inDays(5.2),
                maxAttendees: 50,
                customVenue: { isCustom: true, name: 'Home', city: 'Hyderabad' },
                status: 'approved',
                adminApproval: { status: 'approved' },
                platformFeePercentage: 0,
                isFeatured: true,
                currentAttendees: -40,
                organizer: stranger,
                ticketTiers: [{ name: 'GA', price: 0, maxQuantity: 50, soldCount: 49 }],
            });
        expect(res.status).toBe(201);
        const stored = await Event.findById(res.body._id).lean();
        expect(String(stored.organizer)).toBe(organizer);
        expect(stored.status).toBe('pending');
        expect(stored.adminApproval.status).toBe('pending');
        expect(stored.platformFeePercentage).toBe(5);
        expect(stored.isFeatured).toBe(false);
        expect(stored.currentAttendees).toBe(0);
        expect(stored.ticketTiers[0].soldCount).toBe(0);
    });
});

describe('PUT /events/:id', () => {
    it("refuses someone who is not the organizer", async () => {
        const ev = await makeEvent();
        const res = await request(app).put(`/events/${ev._id}`)
            .set('Authorization', bearer(stranger)).send({ name: 'pwned' });
        expect(res.status).toBe(403);
        expect((await Event.findById(ev._id).lean()).name).toBe('Party');
    });

    it('lets the organizer edit, but not approval state, fee or organizer', async () => {
        const ev = await makeEvent();
        const res = await request(app).put(`/events/${ev._id}`)
            .set('Authorization', bearer(organizer))
            .send({ name: 'Renamed', status: 'approved', platformFeePercentage: 0, organizer: stranger,
                adminApproval: { status: 'approved' } });
        expect(res.status).toBe(200);
        const stored = await Event.findById(ev._id).lean();
        expect(stored.name).toBe('Renamed');
        expect(stored.status).toBe('pending');
        expect(stored.platformFeePercentage).toBe(5);
        expect(String(stored.organizer)).toBe(organizer);
        expect(stored.adminApproval.status).toBe('pending');
    });

    it('lets an admin edit', async () => {
        const ev = await makeEvent();
        const res = await request(app).put(`/events/${ev._id}`)
            .set('Authorization', bearer(admin)).send({ name: 'Admin edit' });
        expect(res.status).toBe(200);
    });

    it('keeps each tier\'s soldCount when the tiers are edited', async () => {
        const ev = await makeEvent({ ticketTiers: [{ name: 'VIP', price: 500, maxQuantity: 20, soldCount: 7 }] });
        const res = await request(app).put(`/events/${ev._id}`)
            .set('Authorization', bearer(organizer))
            .send({ ticketTiers: [
                { name: 'VIP', price: 600, maxQuantity: 25, description: '' },
                { name: 'GA', price: 100, maxQuantity: 50, description: '' },
            ] });
        expect(res.status).toBe(200);
        const tiers = (await Event.findById(ev._id).lean()).ticketTiers;
        expect(tiers.find((t: any) => t.name === 'VIP').soldCount).toBe(7);
        expect(tiers.find((t: any) => t.name === 'VIP').price).toBe(600);
        expect(tiers.find((t: any) => t.name === 'GA').soldCount).toBe(0);
    });

    it('refuses to drop a tier that has sales, or shrink it below what it sold', async () => {
        const ev = await makeEvent({ ticketTiers: [{ name: 'VIP', price: 500, maxQuantity: 20, soldCount: 7 }] });
        const dropped = await request(app).put(`/events/${ev._id}`)
            .set('Authorization', bearer(organizer))
            .send({ ticketTiers: [{ name: 'GA', price: 100, maxQuantity: 50 }] });
        expect(dropped.status).toBe(400);
        const shrunk = await request(app).put(`/events/${ev._id}`)
            .set('Authorization', bearer(organizer))
            .send({ ticketTiers: [{ name: 'VIP', price: 500, maxQuantity: 5 }] });
        expect(shrunk.status).toBe(400);
        expect((await Event.findById(ev._id).lean()).ticketTiers[0].soldCount).toBe(7);
    });

    it('sends the event back for venue approval when it moves to another venue', async () => {
        const ev = await makeEvent({ status: 'approved', venueApproval: { status: 'approved' }, adminApproval: { status: 'approved' } });
        const otherVenue = new mongoose.Types.ObjectId();
        await mongoose.connection.db!.collection('venues').insertOne({
            _id: otherVenue, name: 'Other', owner: new mongoose.Types.ObjectId(), status: 'approved', isActive: true,
        });
        const res = await request(app).put(`/events/${ev._id}`)
            .set('Authorization', bearer(organizer)).send({ venue: otherVenue.toString() });
        expect(res.status).toBe(200);
        const stored = await Event.findById(ev._id).lean();
        expect(stored.venueApproval.status).toBe('pending');
        expect(stored.status).toBe('pending');
    });

    it('leaves approval alone when the same venue is re-sent unchanged', async () => {
        const ev = await makeEvent({ status: 'approved', venueApproval: { status: 'approved' }, adminApproval: { status: 'approved' } });
        const res = await request(app).put(`/events/${ev._id}`)
            .set('Authorization', bearer(organizer)).send({ venue: venueId.toString(), name: 'Same venue' });
        expect(res.status).toBe(200);
        const stored = await Event.findById(ev._id).lean();
        expect(stored.venueApproval.status).toBe('approved');
        expect(stored.status).toBe('approved');
    });
});

describe('DELETE /events/:id and POST /events/:id/cancel', () => {
    it('refuse someone who is not the organizer', async () => {
        const ev = await makeEvent();
        const del = await request(app).delete(`/events/${ev._id}`).set('Authorization', bearer(stranger));
        expect(del.status).toBe(403);
        const cancel = await request(app).post(`/events/${ev._id}/cancel`).set('Authorization', bearer(stranger)).send({});
        expect(cancel.status).toBe(403);
        const stored = await Event.findById(ev._id).lean();
        expect(stored.isDeleted).not.toBe(true);
        expect(stored.status).toBe('pending');
    });

    it('let the organizer delete', async () => {
        const ev = await makeEvent();
        const del = await request(app).delete(`/events/${ev._id}`).set('Authorization', bearer(organizer));
        expect(del.status).toBe(200);
        expect((await Event.findById(ev._id).lean()).isDeleted).toBe(true);
    });
});

describe('approvals', () => {
    it('admin-approve rejects anonymous and non-admin callers', async () => {
        const ev = await makeEvent();
        const anon = await request(app).post(`/events/${ev._id}/admin-approve`).send({ adminId: admin, status: 'approved' });
        expect(anon.status).toBe(401);
        const user = await request(app).post(`/events/${ev._id}/admin-approve`)
            .set('Authorization', bearer(stranger)).send({ adminId: admin, status: 'approved' });
        expect(user.status).toBe(403);
        expect((await Event.findById(ev._id).lean()).adminApproval.status).toBe('pending');
    });

    it('admin-approve works for an admin and records who acted', async () => {
        const ev = await makeEvent();
        const res = await request(app).post(`/events/${ev._id}/admin-approve`)
            .set('Authorization', bearer(admin)).send({ adminId: 'spoofed', status: 'approved' });
        expect(res.status).toBe(200);
        const stored = await Event.findById(ev._id).lean();
        expect(stored.adminApproval.status).toBe('approved');
        expect(stored.adminApproval.respondedBy).toBe(admin);
    });

    it('venue-approve ignores venueOwnerId in the body and checks the caller', async () => {
        const ev = await makeEvent();
        const spoof = await request(app).post(`/events/${ev._id}/venue-approve`)
            .set('Authorization', bearer(stranger)).send({ venueOwnerId: venueOwner, status: 'approved' });
        expect(spoof.status).toBe(403);
        expect((await Event.findById(ev._id).lean()).venueApproval.status).toBe('pending');

        const real = await request(app).post(`/events/${ev._id}/venue-approve`)
            .set('Authorization', bearer(venueOwner)).send({ status: 'approved' });
        expect(real.status).toBe(200);
        expect((await Event.findById(ev._id).lean()).venueApproval.status).toBe('approved');
    });

    it('admin-pending and venue-requests require sign-in', async () => {
        expect((await request(app).get('/events/admin-pending')).status).toBe(401);
        expect((await request(app).get('/events/admin-pending').set('Authorization', bearer(stranger))).status).toBe(403);
        expect((await request(app).get(`/events/venue-requests?userId=${venueOwner}`)).status).toBe(401);
    });

    it("venue-requests returns the caller's own queue, not the one named in ?userId", async () => {
        await makeEvent();
        const own = await request(app).get('/events/venue-requests').set('Authorization', bearer(venueOwner));
        expect(own.status).toBe(200);
        const spoof = await request(app).get(`/events/venue-requests?userId=${venueOwner}`)
            .set('Authorization', bearer(stranger));
        expect(spoof.status).toBe(200);
        expect(JSON.stringify(spoof.body)).not.toContain('Party');
        expect(JSON.stringify(own.body)).toContain('Party');
    });
});

describe('PUT /events/:id/access/:requestId', () => {
    it('only the organizer can approve, and the request must belong to the event', async () => {
        const ev = await makeEvent({ eventType: 'private' });
        const req = await PrivateEventAccess.create({ user: stranger, event: ev._id, accessCode: 'X' });

        const self = await request(app).put(`/events/${ev._id}/access/${req._id}`)
            .set('Authorization', bearer(stranger)).send({ status: 'approved' });
        expect(self.status).toBe(403);

        const other = await makeEvent({ name: 'Other' });
        const wrongEvent = await request(app).put(`/events/${other._id}/access/${req._id}`)
            .set('Authorization', bearer(organizer)).send({ status: 'approved' });
        expect(wrongEvent.status).toBe(400);
        expect((await PrivateEventAccess.findById(req._id).lean()).status).toBe('pending');

        const ok = await request(app).put(`/events/${ev._id}/access/${req._id}`)
            .set('Authorization', bearer(organizer)).send({ status: 'approved' });
        expect(ok.status).toBe(200);
        expect((await PrivateEventAccess.findById(req._id).lean()).status).toBe('approved');
    });
});
