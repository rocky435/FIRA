/**
 * FIRA's commission on what organisers and venue owners earn.
 *
 * A percentage of the owner's share, set per person by an admin and editable
 * per listing, deducted from what FIRA pays them. Separate from the platform
 * fee buyers pay. Admin-only: the owner's own settlement view, their profile,
 * and the event/venue they just created must carry no trace of it.
 *
 *   owner's share ₹20,000 at 4%  ->  ₹800 deducted, ₹19,200 to pay
 */
import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.REDIS_HOST;

const adminRoutes = require('../routes/admin');
const User = require('../models/User');
const Event = require('../models/Event');
const Venue = require('../models/Venue');
const Payment = require('../models/Payment');
const Settlement = require('../models/Settlement');
const AuditLog = require('../models/AuditLog');
const settlementService = require('../services/settlementService');
const commissionService = require('../services/commissionService');
const eventService = require('../services/eventService');
const venueService = require('../services/venueService');
const { commissionOn, parseRate } = require('../utils/commission');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const oid = () => new mongoose.Types.ObjectId();
const db = () => mongoose.connection.db!;
const tokenFor = (u: any) => jwt.sign({ userId: String(u._id) }, process.env.JWT_SECRET as string);
const as = (u: any) => ({ Authorization: `Bearer ${tokenFor(u)}` });

let admin: any;
let moderator: any;
let organizer: any;

async function makeUser(extra: Record<string, unknown> = {}) {
    return User.create({ name: 'Olive Organizer', email: `${oid()}@x.test`, password: 'x', panNumber: 'ABCDE1234F', panStatus: 'verified', ...extra });
}

/** An event whose organiser's share is `share` (one paid payment at that listed price). */
async function makeEvent(owner: any, share = 20000, extra: Record<string, unknown> = {}) {
    const _id = oid();
    await db().collection('events').insertOne({ _id, name: 'Sunburn Arena', organizer: owner._id, status: 'approved', ...extra });
    if (share > 0) {
        await Payment.create({
            user: oid(), type: 'ticket_purchase', referenceId: _id, referenceModel: 'Event',
            amount: share, platformFee: share * 0.05, gstAmount: share * 0.009, totalAmount: share * 1.059,
            listedPrice: share, status: 'success', paidAt: new Date('2024-05-01T10:00:00.000Z'),
        });
    }
    return _id;
}

const settlementOf = (id: any) => request(app).get(`/api/admin/listings/event/${id}/settlement`).set(as(admin));
const setListing = (id: any, percentage: unknown, who = admin) =>
    request(app).patch(`/api/admin/listings/event/${id}/commission`).set(as(who)).send({ percentage });
const setOwner = (id: any, percentage: unknown, who = admin) =>
    request(app).patch(`/api/admin/users/${id}/commission`).set(as(who)).send({ percentage });
const pay = (id: any, amount: number, key: string) =>
    request(app).post(`/api/admin/listings/event/${id}/settlement/entries`).set(as(admin))
        .send({ settledAmount: amount, settlementReference: `UTR-${key}`, settledAt: '2024-05-04T00:00:00.000Z', idempotencyKey: key });

beforeEach(async () => {
    await Settlement.init();
    admin = await User.create({ name: 'Ada Admin', email: `${oid()}@x.test`, password: 'x', role: 'admin', roles: ['admin'], adminRole: 'admin' });
    moderator = await User.create({ name: 'Mo Moderator', email: `${oid()}@x.test`, password: 'x', role: 'admin', roles: ['admin'], adminRole: 'moderator' });
    organizer = await makeUser();
});

describe('the maths', () => {
    it('deducts the percentage from the owner share, to pay in whole rupees', () => {
        expect(commissionOn(20000, 4)).toEqual({ percentage: 4, amount: 800, netPayable: 19200 });
        expect(commissionOn(9010, 4)).toEqual({ percentage: 4, amount: 360.4, netPayable: 8649 });
        expect(commissionOn(999, 2.5)).toEqual({ percentage: 2.5, amount: 24.98, netPayable: 974 });
        // No rate, or nonsense, is 0% - never a negative or inflated payout.
        for (const none of [null, undefined, 0, NaN, -5]) expect(commissionOn(20000, none as any)).toEqual({ percentage: 0, amount: 0, netPayable: 20000 });
        expect(commissionOn(20000, 100).netPayable).toBe(0);
    });

    it('accepts 0-100 with up to two decimals, and nothing else', () => {
        expect(parseRate('4')).toBe(4);
        expect(parseRate(2.5)).toBe(2.5);
        expect(parseRate('')).toBeNull();
        expect(parseRate(null)).toBeNull();
        for (const bad of [-1, 101, 'abc', 4.123, Infinity]) expect(() => parseRate(bad)).toThrow();
    });
});

describe('a listing with a rate', () => {
    it('with no rate set, nothing changes: the owner share is what is owed', async () => {
        const id = await makeEvent(organizer);
        const { body } = await settlementOf(id);
        expect(body.money).toMatchObject({ ownerShare: 20000, commissionPercentage: 0, commissionAmount: 0, netPayable: 20000, outstandingAmount: 20000 });
        expect(body.commission).toMatchObject({ percentage: 0, custom: false });
    });

    it('4% of ₹20,000 deducts ₹800 and leaves ₹19,200 to pay', async () => {
        const id = await makeEvent(organizer);
        const res = await setListing(id, 4);
        expect(res.status).toBe(200);
        expect(res.body.money).toMatchObject({
            ownerShare: 20000, commissionPercentage: 4, commissionAmount: 800,
            netPayableBeforeCommission: 20000, netPayable: 19200, outstandingAmount: 19200,
        });
        expect(res.body.commission).toMatchObject({ percentage: 4, custom: true });

        // The over-payment guard now measures against ₹19,200.
        expect((await pay(id, 19201, 'too-much')).status).toBe(409);
        const ok = await pay(id, 19200, 'exact');
        expect(ok.status).toBe(200);
        expect(ok.body.state).toBe('fully_settled');

        // The payout's audit entry keeps the rate it was measured against.
        const settle = await AuditLog.findOne({ action: 'settle', entityId: id }).lean();
        expect(settle.metadata).toMatchObject({ commissionPercentage: 4, commissionAmount: 800, netPayable: 19200 });
    });

    it('a rate change is recorded, with who and from/to', async () => {
        const id = await makeEvent(organizer);
        await setListing(id, 4);
        await setListing(id, 5);
        const entries = await AuditLog.find({ entityId: id, 'metadata.field': 'commissionPercentage' }).sort({ timestamp: 1 }).lean();
        expect(entries.map((e: any) => [e.metadata.from, e.metadata.to])).toEqual([[0, 4], [4, 5]]);
        expect(String(entries[0].adminUser)).toBe(String(admin._id));
    });

    it('cannot be raised to where less is owed than was already paid', async () => {
        const id = await makeEvent(organizer);
        await pay(id, 19500, 'k1');
        const res = await setListing(id, 4); // would leave ₹19,200 owed against ₹19,500 paid
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('below_settled');
        expect(res.body.error).toMatch(/already been paid/);
        expect((await settlementOf(id)).body.money.commissionPercentage).toBe(0);
        // A rate that still covers what was paid is fine.
        expect((await setListing(id, 2)).status).toBe(200);
    });

    it('rejects a bad number, a moderator, and an unknown listing', async () => {
        const id = await makeEvent(organizer);
        expect((await setListing(id, 150)).status).toBe(400);
        expect((await setListing(id, 'lots')).status).toBe(400);
        expect((await setListing(id, 4, moderator)).status).toBe(403);
        expect((await setListing(oid(), 4)).status).toBe(404);
        expect((await settlementOf(id)).body.money.commissionPercentage).toBe(0);
    });

    it('the Payouts list uses the same rate', async () => {
        const id = await makeEvent(organizer, 20000, { endDateTime: new Date('2024-05-02T00:00:00.000Z') });
        await setListing(id, 4);
        const { rows } = await settlementService.getPayoutQueue({ kind: 'event' });
        const row = rows.find((r: any) => r.id === String(id));
        expect(row.money).toMatchObject({ netPayable: 19200, commissionPercentage: 4, commissionAmount: 800, dueNow: 19200 });
    });
});

describe("a person's rate", () => {
    it('applies to their unpaid listings, skips hand-set and already-paid ones, and says which', async () => {
        const plain = await makeEvent(organizer);
        const custom = await makeEvent(organizer);
        const paid = await makeEvent(organizer);
        const venueId = oid();
        await db().collection('venues').insertOne({ _id: venueId, name: 'Lotus Hall', owner: organizer._id, status: 'approved' });
        await setListing(custom, 2);
        await pay(paid, 1000, 'paid-1');

        const res = await setOwner(organizer._id, 5);
        expect(res.status).toBe(200);
        expect(res.body.percentage).toBe(5);
        expect(res.body.applied.map((a: any) => a.id).sort()).toEqual([String(plain), String(venueId)].sort());
        expect(res.body.kept.map((k: any) => [k.id, k.reason, k.percentage]).sort()).toEqual(
            [[String(custom), 'custom', 2], [String(paid), 'paid', 0]].sort());

        expect((await settlementOf(plain)).body.money).toMatchObject({ commissionPercentage: 5, netPayable: 19000 });
        expect((await settlementOf(custom)).body.money.commissionPercentage).toBe(2);
        expect((await settlementOf(paid)).body.money.commissionPercentage).toBe(0);
        expect((await Venue.findById(venueId).select('+commissionPercentage').lean()).commissionPercentage).toBe(5);

        const audit = await AuditLog.findOne({ entityType: 'user', entityId: organizer._id }).lean();
        expect(audit.metadata).toMatchObject({ field: 'commissionPercentage', from: null, to: 5, listingsUpdated: 2, listingsKept: 2 });

        const view = await request(app).get(`/api/admin/users/${organizer._id}/commission`).set(as(admin));
        expect(view.body.percentage).toBe(5);
        expect(view.body.listings).toHaveLength(4);
    });

    it('is copied onto the events and venues they create afterwards', async () => {
        await setOwner(organizer._id, 6);
        const event = await eventService.createEvent({
            organizer: organizer._id, name: 'New Gig', description: 'd', category: 'music', maxAttendees: 50,
            startDateTime: new Date(Date.now() + 20 * 864e5), endDateTime: new Date(Date.now() + 20.2 * 864e5),
            customVenue: { isCustom: true, name: 'Lawn', city: 'Pune', locationLink: 'https://maps.example/x' },
        });
        const venue = await venueService.createVenue({
            owner: organizer._id, name: 'New Hall', description: 'd', capacity: { min: 1, max: 100 },
            pricing: { basePrice: 1000, pricePerDay: 1000 }, address: { street: 's', city: 'Pune', state: 'MH', pincode: '411001' },
        });
        expect((await Event.findById(event._id).select('+commissionPercentage').lean()).commissionPercentage).toBe(6);
        expect((await Venue.findById(venue._id).select('+commissionPercentage').lean()).commissionPercentage).toBe(6);

        // The just-created documents are returned to their owner: no commission in them.
        for (const doc of [event, venue]) {
            const sent = JSON.parse(JSON.stringify(doc));
            expect(sent).not.toHaveProperty('commissionPercentage');
            expect(sent).not.toHaveProperty('commissionCustom');
        }
    });

    it('putting a listing back on the owner rate', async () => {
        const id = await makeEvent(organizer);
        await setOwner(organizer._id, 5);
        await setListing(id, 2);
        const back = await setListing(id, null);
        expect(back.body.commission).toMatchObject({ percentage: 5, custom: false });
        expect(back.body.money.netPayable).toBe(19000);
    });

    it('a venue owner cannot set their own rate through a venue edit', async () => {
        const venueId = oid();
        await db().collection('venues').insertOne({ _id: venueId, name: 'Lotus Hall', owner: organizer._id, status: 'approved' });
        await venueService.updateVenue(String(venueId), { name: 'Renamed', commissionPercentage: 0, commissionCustom: true });
        const stored = await Venue.findById(venueId).select('+commissionPercentage +commissionCustom').lean();
        expect(stored.name).toBe('Renamed');
        expect(stored.commissionPercentage ?? null).toBeNull();
        expect(stored.commissionCustom ?? false).toBe(false);
    });
});

describe('owners see nothing of it', () => {
    it('the owner settlement view is unchanged by the commission', async () => {
        const id = await makeEvent(organizer);
        const before = await settlementService.getOwnerSettlement({ kind: 'event', listingId: String(id), requesterId: organizer._id });
        await setListing(id, 4);
        await pay(id, 19200, 'full');
        const after = await settlementService.getOwnerSettlement({ kind: 'event', listingId: String(id), requesterId: organizer._id });

        // Same share as before; the commission shows only as not yet paid.
        expect(after.money.netPayable).toBe(before.money.netPayable);
        expect(after.money).toMatchObject({ netPayable: 20000, settledToDate: 19200, outstandingAmount: 800 });
        expect(Object.keys(after.money).sort()).toEqual(Object.keys(before.money).sort());
        expect(JSON.stringify(after)).not.toMatch(/commission(Percentage|Amount|Custom)|BeforeCommission/);
    });

    it("the owner's notification about a payout carries owner-view figures only", async () => {
        const Notification = require('../models/Notification');
        const id = await makeEvent(organizer);
        await setListing(id, 4);
        await pay(id, 10000, 'part');
        const note = await Notification.findOne({ user: organizer._id, type: 'settlement_recorded' }).lean();
        expect(note.data.extra).toMatchObject({ settledToDate: 10000, outstandingAmount: 10000 }); // of ₹20,000, not ₹19,200
        expect(JSON.stringify(note)).not.toMatch(/commission/i);
    });

    it("the owner's own profile and listings never carry the rate", async () => {
        const id = await makeEvent(organizer);
        await setOwner(organizer._id, 5);
        expect(JSON.stringify(await User.findById(organizer._id))).not.toMatch(/commissionPercentage/);
        expect(JSON.stringify(await Event.findById(id))).not.toMatch(/commission/);
        expect(JSON.stringify(await Event.findById(id).lean())).not.toMatch(/commission/);
        // The admin can still read it.
        expect((await commissionService.describeOwner(organizer._id)).percentage).toBe(5);
    });
});
