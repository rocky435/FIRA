/**
 * Admin alerts, the Event Organisers list, the dashboard trends and /admin/me.
 *
 * Alerts go to the installed admin app only (PushSubscription.app = 'admin'),
 * never to the website, and website notifications never reach the admin app.
 * Review alerts reach every admin level; refund / ID / removal alerts only
 * admins and super admins. A burst becomes one summary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ADMIN_ALERT_BATCH_MS = '60000';
delete process.env.REDIS_HOST;

// pushService reads its VAPID keys when it loads, so they are set first.
const webpush = require('web-push');
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
}
const pushService = require('../services/pushService');
const adminAlertService = require('../services/adminAlertService');
const adminService = require('../services/adminService');
const venueService = require('../services/venueService');
const PushSubscription = require('../models/PushSubscription');
const User = require('../models/User');
const adminRoutes = require('../routes/admin');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const oid = () => new mongoose.Types.ObjectId();
const db = () => mongoose.connection.db!;
const as = (u: any) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(u._id) }, process.env.JWT_SECRET as string)}` });

let superAdmin: any, admin: any, moderator: any, customer: any;
let sent: Array<{ endpoint: string; body: any }>;

const sub = (n: string, host = 'web.push.apple.com') => ({
    endpoint: `https://${host}/${n}`,
    keys: { p256dh: `p256-${n}-${'x'.repeat(20)}`, auth: `auth-${n}` },
});

beforeEach(async () => {
    sent = [];
    vi.spyOn(webpush, 'sendNotification').mockImplementation(async (s: any, body: any) => {
        sent.push({ endpoint: s.endpoint, body: JSON.parse(body) });
        if (s.endpoint.includes('gone')) throw Object.assign(new Error('Gone'), { statusCode: 410, body: '{"reason":"Unregistered"}' });
        if (s.endpoint.includes('bad')) throw Object.assign(new Error('Bad'), { statusCode: 400, body: '{"reason":"BadJwtToken"}' });
        return { statusCode: 201 };
    });
    superAdmin = await User.create({ name: 'Sam Super', email: `${oid()}@x.test`, password: 'x', role: 'admin', roles: ['admin'], adminRole: 'super_admin' });
    admin = await User.create({ name: 'Ada Admin', email: `${oid()}@x.test`, password: 'x', role: 'admin', roles: ['admin'], adminRole: 'admin' });
    moderator = await User.create({ name: 'Mo Moderator', email: `${oid()}@x.test`, password: 'x', role: 'admin', roles: ['admin'], adminRole: 'moderator' });
    customer = await User.create({ name: 'Cara Customer', email: `${oid()}@x.test`, password: 'x' });
});
afterEach(async () => {
    await adminAlertService.flushAll();
    vi.restoreAllMocks();
});


describe('turning alerts on and testing them', () => {
    it('stores the subscription as the admin app, and the test reports each push service answer', async () => {
        const fresh = pushService;
        await request(app).post('/api/admin/alerts/subscribe').set(as(admin)).send({ subscription: sub('a1') }).expect(201);
        const row = await PushSubscription.findOne({ endpoint: sub('a1').endpoint }).lean();
        expect(row.app).toBe('admin');
        expect(String(row.user)).toBe(String(admin._id));

        await request(app).post('/api/admin/alerts/subscribe').set(as(admin)).send({ subscription: sub('bad-1', 'fcm.googleapis.com') }).expect(201);
        const res = await request(app).post('/api/admin/alerts/test').set(as(admin));
        expect(res.status).toBe(200);
        const byService = Object.fromEntries(res.body.results.map((r: any) => [r.service, r]));
        expect(byService.Apple).toMatchObject({ ok: true, status: 201 });
        expect(byService.Google).toMatchObject({ ok: false, status: 400, reason: 'BadJwtToken' });
        expect(fresh).toBeTruthy();
    });

    it('a test with no device says so', async () => {
        const res = await request(app).post('/api/admin/alerts/test').set(as(moderator));
        expect([404, 503]).toContain(res.status);
        expect(res.body.error).toBeTruthy();
    });
});

describe('who gets which alert', () => {
    beforeEach(async () => {
        for (const [u, n] of [[superAdmin, 's'], [admin, 'a'], [moderator, 'm']] as const) {
            await PushSubscription.create({ user: u._id, ...sub(`admin-${n}`), app: 'admin' });
        }
        // The same admin's website subscription, and a customer's.
        await PushSubscription.create({ user: admin._id, ...sub('web-a'), app: 'web' });
        await PushSubscription.create({ user: customer._id, ...sub('web-c') });
    });

    it('review alerts reach every level, on the admin app only', async () => {
        const svc = adminAlertService;
        svc.notify('venue', { body: 'Lotus Hall, Pune', url: '/venues/1' });
        await svc.flushAll();
        expect(sent.map((s) => s.endpoint).sort()).toEqual([sub('admin-a').endpoint, sub('admin-m').endpoint, sub('admin-s').endpoint].sort());
        expect(sent[0].body).toMatchObject({ title: 'New venue to review', body: 'Lotus Hall, Pune', url: '/venues/1', tag: 'fira-admin-venue' });
    });

    it('money and ID alerts skip moderators', async () => {
        const svc = adminAlertService;
        svc.notify('refund', { body: '₹500 to refund' });
        svc.notify('idCheck', { body: 'Priya sent their PAN' });
        await svc.flushAll();
        const endpoints = sent.map((s) => s.endpoint);
        expect(endpoints).not.toContain(sub('admin-m').endpoint);
        expect(endpoints.filter((e) => e === sub('admin-a').endpoint)).toHaveLength(2);
    });

    it('a burst becomes one summary', async () => {
        const svc = adminAlertService;
        for (let i = 0; i < 5; i++) svc.notify('refund', { body: `₹${100 + i} to refund` });
        await svc.flushAll();
        const toAdmin = sent.filter((s) => s.endpoint === sub('admin-a').endpoint);
        expect(toAdmin).toHaveLength(1);
        expect(toAdmin[0].body).toMatchObject({ title: '5 refunds to pay', body: '₹100 to refund and 4 more.', url: '/refunds' });
    });

    it('website notifications never reach the admin app', async () => {
        const fresh = pushService;
        await fresh.sendToUsers([admin._id, customer._id], { title: 'Booking accepted' });
        expect(sent.map((s) => s.endpoint).sort()).toEqual([sub('web-a').endpoint, sub('web-c').endpoint].sort());
    });

    it('a device the push service says is gone is removed', async () => {
        await PushSubscription.create({ user: admin._id, ...sub('gone-1'), app: 'admin' });
        const fresh = pushService;
        const res = await fresh.sendToUser(admin._id, { title: 't' }, { app: 'admin' });
        expect(res.results.find((r: any) => r.status === 410)).toMatchObject({ ok: false, removed: true, reason: 'Unregistered' });
        expect(await PushSubscription.countDocuments({ endpoint: sub('gone-1').endpoint })).toBe(0);
    });

    it('a new venue raises the alert', async () => {
        const owner = await User.create({ name: 'Priya', email: `${oid()}@x.test`, password: 'x' });
        const spy = vi.spyOn(require('../services/adminAlertService'), 'notify');
        await venueService.createVenue({
            owner: owner._id, name: 'Lotus Hall', description: 'd', capacity: { min: 1, max: 100 },
            pricing: { basePrice: 1000, pricePerDay: 1000 }, address: { street: 's', city: 'Pune', state: 'MH', pincode: '411001' },
        });
        expect(spy).toHaveBeenCalledWith('venue', expect.objectContaining({ body: 'Lotus Hall, Pune' }));
    });
});

describe('/admin/me', () => {
    it('tells the admin app their level, so moderators get the shorter menu', async () => {
        expect((await request(app).get('/api/admin/me').set(as(moderator))).body).toMatchObject({ name: 'Mo Moderator', adminRole: 'moderator' });
        expect((await request(app).get('/api/admin/me').set(as(admin))).body.adminRole).toBe('admin');
        expect((await request(app).get('/api/admin/me').set(as(customer))).status).toBe(403);
    });
});

describe('Event Organisers', () => {
    it('lists organisers with their events, PAN and counts; admins only', async () => {
        const org = await User.create({ name: 'Neon Events', email: `${oid()}@x.test`, password: 'x', panStatus: 'pending', bankDetails: { accountName: 'Neon', accountNumber: '1234567890', ifscCode: 'HDFC0000001', bankName: 'HDFC' } });
        await db().collection('events').insertMany([
            { _id: oid(), name: 'Gig A', organizer: org._id, status: 'approved', currentAttendees: 10, maxAttendees: 50, startDateTime: new Date() },
            { _id: oid(), name: 'Gig B', organizer: org._id, status: 'pending', currentAttendees: 0, maxAttendees: 50, startDateTime: new Date() },
            { _id: oid(), name: 'Gone', organizer: org._id, status: 'approved', isDeleted: true },
        ]);
        const res = await request(app).get('/api/admin/event-organisers').set(as(admin));
        expect(res.status).toBe(200);
        const row = res.body.organisers.find((o: any) => o.name === 'Neon Events');
        expect(row.counts).toMatchObject({ total: 2, live: 1, pending: 1, ticketsSold: 10 });
        expect(row.panStatus).toBe('pending');
        expect(row.bankDetails.accountNumber).toBe('1234567890');
        expect(row.password).toBeUndefined();
        expect((await request(app).get('/api/admin/event-organisers?search=neon').set(as(admin))).body.organisers).toHaveLength(1);
        expect((await request(app).get('/api/admin/event-organisers').set(as(moderator))).status).toBe(403);
    });
});

describe('dashboard trends', () => {
    it('gives six months, oldest first, with sign-ups, money and tickets', async () => {
        const now = new Date('2026-11-15T10:00:00.000Z');
        await db().collection('payments').insertMany([
            { _id: oid(), user: oid(), type: 'ticket', referenceModel: 'Event', referenceId: oid(), amount: 1000, totalAmount: 1059, status: 'success', paidAt: new Date('2026-11-02T10:00:00Z') },
            { _id: oid(), user: oid(), type: 'venue_booking', referenceModel: 'Booking', referenceId: oid(), amount: 5000, totalAmount: 5000, status: 'success', paidAt: new Date('2026-10-20T10:00:00Z') },
            { _id: oid(), user: oid(), type: 'ticket', referenceModel: 'Event', referenceId: oid(), amount: 999, totalAmount: 999, status: 'failed', paidAt: new Date('2026-11-03T10:00:00Z') },
        ]);
        const trends = await adminService.getTrends(now);
        expect(trends.map((t: any) => t.month)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
        expect(trends[5]).toMatchObject({ ticketRevenue: 1059, venueRevenue: 0 });
        expect(trends[4]).toMatchObject({ ticketRevenue: 0, venueRevenue: 5000 });
        expect(trends[0]).toMatchObject({ newUsers: 0, ticketRevenue: 0, venueRevenue: 0, ticketsSold: 0 });
    });
});
