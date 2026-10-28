/**
 * Identity checks reviewed by an admin (services/identityService.js):
 *   - users submit a government ID or PAN; it waits as 'pending';
 *   - only an admin verifies or rejects it, with a reason the user sees;
 *   - a venue cannot be approved until its owner's ID is verified;
 *   - event earnings cannot be recorded as paid out until the organiser's
 *     PAN is verified.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'b'.repeat(64);
// Signing an expiring document link needs Cloudinary credentials (dummy here).
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'demo';
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '123';
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'secret';
delete process.env.REDIS_HOST;

const User = require('../models/User');
const Venue = require('../models/Venue');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const { isSealed } = require('../utils/fieldEncryption');
const paymentService = require('../services/paymentService');

const app = express();
app.use(express.json());
app.use('/users', require('../routes/user'));
app.use('/admin', require('../routes/admin'));

const DOC = 'https://res.cloudinary.com/demo/image/authenticated/s--abc--/v1700/fira/gov-ids/pan1.jpg';
const bearer = (u: any) => `Bearer ${jwt.sign({ userId: String(u._id) }, process.env.JWT_SECRET as string)}`;

async function makeUser(over: Record<string, any> = {}) {
    return User.create({ name: 'Uma', email: `${new mongoose.Types.ObjectId()}@x.test`, password: 'x'.repeat(10), ...over });
}
const makeAdmin = () => makeUser({ name: 'Ada', role: 'admin', roles: ['admin'], adminRole: 'super_admin' });

let admin: any;
beforeEach(async () => {
    admin = await makeAdmin();
});

const submitPan = (u: any, body: Record<string, any> = {}) =>
    request(app).put('/users/me/identity/pan').set('Authorization', bearer(u))
        .send({ panNumber: 'abcde1234f', panDocument: DOC, ...body });
const review = (who: any, u: any, kind: string, body: Record<string, any>) =>
    request(app).put(`/admin/users/${u._id}/identity/${kind}/review`).set('Authorization', bearer(who)).send(body);

describe('submitting', () => {
    it('stores the PAN encrypted, as pending, and shows the user only its last four', async () => {
        const u = await makeUser();
        const res = await submitPan(u);
        expect(res.status).toBe(200);
        expect(res.body.pan).toMatchObject({ status: 'pending', numberLast4: '234F', hasDocument: true, rejectionReason: null });
        expect(JSON.stringify(res.body)).not.toContain('ABCDE1234F');

        const stored: any = await mongoose.connection.db!.collection('users').findOne({ _id: u._id });
        expect(isSealed(stored.panNumber)).toBe(true);
        expect(stored.panStatus).toBe('pending');
    });

    it('refuses a malformed PAN, or a document that is not in the private folder', async () => {
        const u = await makeUser();
        const bad = await submitPan(u, { panNumber: '1234' });
        expect(bad.status).toBe(400);
        expect(bad.body.field).toBe('panNumber');
        const publicDoc = await submitPan(u, { panDocument: 'https://example.com/someone-else.jpg' });
        expect(publicDoc.status).toBe(400);
        expect(publicDoc.body.field).toBe('panDocument');
    });

    it('a user cannot mark themselves verified through the profile update', async () => {
        const u = await makeUser();
        await request(app).put(`/users/${u._id}`).set('Authorization', bearer(u))
            .send({ panStatus: 'verified', govIdStatus: 'verified', govIdVerified: true });
        const fresh = await User.findById(u._id).lean();
        expect(fresh.panStatus).toBe('none');
        expect(fresh.govIdStatus).toBe('none');
        expect(fresh.govIdVerified).toBe(false);
    });
});

describe('admin review', () => {
    it('is admin-only', async () => {
        const u = await makeUser();
        await submitPan(u);
        const stranger = await makeUser();
        expect((await review(stranger, u, 'pan', { action: 'verify' })).status).toBe(403);
        expect((await request(app).get('/admin/identity-checks').set('Authorization', bearer(stranger))).status).toBe(403);
    });

    it('lists pending checks, including legacy owners who have a document but no status', async () => {
        const fresh = await makeUser();
        await submitPan(fresh);
        const legacyId = new mongoose.Types.ObjectId();
        await mongoose.connection.db!.collection('users').insertOne({
            _id: legacyId, name: 'Old Owner', email: 'old@x.test', govIdType: 'aadhar', govIdNumber: '123412341234', govIdDocument: DOC,
        });
        const done = await makeUser({ govIdType: 'pan', govIdNumber: 'ABCDE1234F', govIdDocument: DOC, govIdStatus: 'verified' });

        const res = await request(app).get('/admin/identity-checks').set('Authorization', bearer(admin));
        expect(res.status).toBe(200);
        const ids = res.body.users.map((x: any) => String(x._id));
        expect(ids).toContain(String(fresh._id));
        expect(ids).toContain(String(legacyId));
        expect(ids).not.toContain(String(done._id));
        const legacy = res.body.users.find((x: any) => String(x._id) === String(legacyId));
        expect(legacy.govId).toMatchObject({ status: 'pending', number: '123412341234' });
        expect(legacy.govId.documentUrl).toContain('expires_at=');
    });

    it('rejecting needs a reason, which the user is shown and notified about', async () => {
        const u = await makeUser();
        await submitPan(u);
        expect((await review(admin, u, 'pan', { action: 'reject' })).status).toBe(400);

        const res = await review(admin, u, 'pan', { action: 'reject', reason: 'Photo is blurry' });
        expect(res.status).toBe(200);
        expect(res.body.pan).toMatchObject({ status: 'rejected', rejectionReason: 'Photo is blurry' });

        const own = await request(app).get('/users/me/identity').set('Authorization', bearer(u));
        expect(own.body.pan).toMatchObject({ status: 'rejected', rejectionReason: 'Photo is blurry' });

        const note = await Notification.findOne({ user: u._id }).lean();
        expect(note.type).toBe('verification_rejected');
        expect(note.message).toContain('Photo is blurry');
        const audit = await AuditLog.findOne({ entityId: u._id }).lean();
        expect(audit).toMatchObject({ action: 'reject', entityType: 'user' });
        expect(audit.metadata).toMatchObject({ field: 'panStatus', from: 'pending', to: 'rejected', reason: 'Photo is blurry' });
        expect(String(audit.adminUser)).toBe(String(admin._id));
    });

    it('re-submitting after a rejection goes back to pending and clears the reason', async () => {
        const u = await makeUser();
        await submitPan(u);
        await review(admin, u, 'pan', { action: 'reject', reason: 'Wrong card' });
        const again = await submitPan(u, { panNumber: 'PQRST6789Z' });
        expect(again.body.pan).toMatchObject({ status: 'pending', rejectionReason: null, numberLast4: '789Z' });
    });

    it('verifying the government ID also sets the legacy govIdVerified flag', async () => {
        const u = await makeUser();
        const submit = await request(app).put('/users/me/identity/gov-id').set('Authorization', bearer(u))
            .send({ govIdType: 'aadhar', govIdNumber: '1234 1234 1234', govIdDocument: DOC });
        expect(submit.status).toBe(200);
        const res = await review(admin, u, 'gov-id', { action: 'verify' });
        expect(res.status).toBe(200);
        expect(res.body.govId.status).toBe('verified');
        expect((await User.findById(u._id).lean()).govIdVerified).toBe(true);
    });

    it('refuses to review nothing, or an admin reviewing their own documents', async () => {
        const u = await makeUser();
        expect((await review(admin, u, 'pan', { action: 'verify' })).status).toBe(400);
        await submitPan(admin);
        expect((await review(admin, admin, 'pan', { action: 'verify' })).status).toBe(403);
    });
});

describe('venue approval needs a verified owner ID', () => {
    async function venueOf(owner: any) {
        return Venue.create({ owner: owner._id, name: 'Grand Hall', description: 'd', capacity: { max: 10 },
            pricing: { basePrice: 100, pricePerDay: 100 }, address: { street: 's', city: 'c', state: 's', pincode: '500001' } });
    }
    const approve = (venue: any) => request(app).put(`/admin/venues/${venue._id}/status`)
        .set('Authorization', bearer(admin)).send({ status: 'approved' });

    it('is refused while the ID is pending, and allowed once verified', async () => {
        const owner = await makeUser({ govIdType: 'aadhar', govIdNumber: '123412341234', govIdDocument: DOC, govIdStatus: 'pending' });
        const venue = await venueOf(owner);

        const refused = await approve(venue);
        expect(refused.status).toBe(400);
        expect(refused.body.error).toContain('government ID');
        expect((await Venue.findById(venue._id).lean()).status).not.toBe('approved');

        await review(admin, owner, 'gov-id', { action: 'verify' });
        expect((await approve(venue)).status).toBe(200);
        expect((await Venue.findById(venue._id).lean()).status).toBe('approved');
    });

    it('still lets an admin reject or block an unverified owner\'s venue', async () => {
        const owner = await makeUser();
        const venue = await venueOf(owner);
        const res = await request(app).put(`/admin/venues/${venue._id}/status`)
            .set('Authorization', bearer(admin)).send({ status: 'rejected' });
        expect(res.status).toBe(200);
    });
});

describe('event payouts need a verified organiser PAN', () => {
    async function eventOf(organizer: any) {
        const _id = new mongoose.Types.ObjectId();
        await mongoose.connection.db!.collection('events').insertOne({ _id, name: 'Sunburn', organizer: organizer._id, status: 'approved' });
        return _id;
    }
    const entry = { settledAmount: 5000, settlementReference: 'UTR-1', settledAt: '2024-05-04T00:00:00.000Z', idempotencyKey: 'k-1' };

    it('refuses to record a transfer to an unverified organiser, and says so on the settlement read', async () => {
        const organizer = await makeUser();
        await submitPan(organizer);
        const eventId = await eventOf(organizer);

        const read = await request(app).get(`/admin/listings/event/${eventId}/settlement`).set('Authorization', bearer(admin));
        expect(read.status).toBe(200);
        expect(read.body.payoutCheck).toMatchObject({ required: 'pan', status: 'pending', userId: String(organizer._id) });

        const refused = await request(app).post(`/admin/listings/event/${eventId}/settlement/entries`)
            .set('Authorization', bearer(admin)).send(entry);
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('pan_not_verified');

        await review(admin, organizer, 'pan', { action: 'verify' });
        const after = await request(app).post(`/admin/listings/event/${eventId}/settlement/entries`)
            .set('Authorization', bearer(admin)).send(entry);
        expect(after.body.code).not.toBe('pan_not_verified');
    });

    it('raising an event payout directly is refused too', async () => {
        const organizer = await makeUser();
        await expect(paymentService.processPayout({
            recipientId: organizer._id, type: 'event_tickets', referenceId: new mongoose.Types.ObjectId(),
            referenceModel: 'Event', amount: 100,
        })).rejects.toThrow(/PAN is not verified/);
    });
});
