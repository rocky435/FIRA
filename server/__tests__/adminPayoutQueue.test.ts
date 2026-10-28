/**
 * The admin's cross-listing views: the payout queue (who is owed what, across
 * every venue and event) and the all-venues bookings list.
 *
 * supertest over the real admin router, like adminSettlementRoutes.test.ts.
 * The queue must agree with each listing's own settlement read, and must split
 * what is owed into money from dates that have passed (safe to pay) and money
 * for dates still to come (can still be refunded).
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
const Payment = require('../models/Payment');
const Settlement = require('../models/Settlement');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const DAY = 24 * 60 * 60 * 1000;
const tokenFor = (u: any) => jwt.sign({ userId: String(u._id) }, process.env.JWT_SECRET as string);
const db = () => mongoose.connection.db!;

const bank = { accountName: 'Vik Owner', accountNumber: '123456789012', ifscCode: 'HDFC0000001', bankName: 'HDFC' };

let admin: any;
let owner: any;
let guest: any;
let venueId: mongoose.Types.ObjectId;

async function booking(daysFromNow: number, listedPrice: number, paid = true) {
  const _id = new mongoose.Types.ObjectId();
  const total = listedPrice;
  await db().collection('bookings').insertOne({
    _id, user: guest._id, venue: venueId,
    bookingDate: new Date(Date.now() + daysFromNow * DAY), startTime: '10:00', endTime: '18:00',
    status: 'accepted', paymentStatus: paid ? 'paid' : 'pending', totalAmount: total,
    paymentSchedule: { type: 'full', depositAmount: total, balanceAmount: 0, balanceStatus: 'not_applicable' },
    createdAt: new Date(),
  });
  if (paid) {
    await Payment.create({
      user: guest._id, type: 'venue_booking', referenceId: _id, referenceModel: 'Booking',
      amount: total, subtotal: total, listedPrice, platformFee: total * 0.05, gstAmount: total * 0.009,
      totalAmount: total * 1.059, status: 'success', paidAt: new Date(),
    });
  }
  return _id;
}

beforeEach(async () => {
  await Settlement.init();
  admin = await User.create({
    name: 'Ada Admin', email: `${new mongoose.Types.ObjectId()}@x.test`, password: 'x',
    role: 'admin', roles: ['admin'], adminRole: 'admin',
  });
  owner = await User.create({
    name: 'Vik Owner', email: `${new mongoose.Types.ObjectId()}@x.test`, password: 'x',
    govIdStatus: 'verified', bankDetails: bank,
  });
  guest = await User.create({ name: 'Gita Guest', email: `${new mongoose.Types.ObjectId()}@x.test`, password: 'x' });
  venueId = new mongoose.Types.ObjectId();
  await db().collection('venues').insertOne({ _id: venueId, name: 'Lotus Hall', owner: owner._id, status: 'approved' });
});

const get = (url: string) => request(app).get(url).set('Authorization', `Bearer ${tokenFor(admin)}`);

describe('GET /earnings/payout-queue', () => {
  it('splits what a venue owner is owed into finished and upcoming bookings, net of transfers', async () => {
    await booking(-3, 2000); // already happened
    await booking(10, 1000); // still to come
    await booking(5, 700, false); // accepted, never paid: owes nothing
    await db().collection('settlements').insertOne({
      _id: new mongoose.Types.ObjectId(), listingKind: 'venue', listingModel: 'Venue', listing: venueId,
      settledAmount: 500, settlementReference: 'UTR-1', settledAt: new Date(), method: 'manual',
      idempotencyKey: 'k1', recordedBy: admin._id,
    });

    const res = await get('/api/admin/earnings/payout-queue');

    expect(res.status).toBe(200);
    const row = res.body.rows.find((r: any) => r.id === String(venueId));
    expect(row).toMatchObject({
      kind: 'venue', name: 'Lotus Hall', blockedReason: null,
      owner: { name: 'Vik Owner' },
      money: { netPayable: 3000, settledToDate: 500, outstandingAmount: 2500, dueNow: 1500, upcoming: 1000 },
    });
    // Masked in the list; the full number is only on the listing's own read.
    expect(row.payTo).toMatchObject({ ifscCode: 'HDFC0000001', bankName: 'HDFC' });
    expect(row.payTo.accountNumber).toBe('********9012');
    expect(res.body.totals).toMatchObject({ outstanding: 2500, dueNow: 1500, owedListings: 1 });

    // The queue and the listing's own settlement panel agree.
    const panel = await get(`/api/admin/listings/venue/${venueId}/settlement`);
    expect(panel.body.money.outstandingAmount).toBe(row.money.outstandingAmount);
    expect(panel.body.payTo).toMatchObject({ ...bank, fromListing: false });
  });

  it('leaves out venues nobody has paid for', async () => {
    await booking(5, 700, false);
    const res = await get('/api/admin/earnings/payout-queue');
    expect(res.body.rows.find((r: any) => r.id === String(venueId))).toBeUndefined();
  });

  it('flags an event whose organiser has no verified PAN, and an owner with no bank account', async () => {
    const organizer = await User.create({ name: 'Ola', email: `${new mongoose.Types.ObjectId()}@x.test`, password: 'x', bankDetails: bank });
    const eventId = new mongoose.Types.ObjectId();
    await db().collection('events').insertOne({
      _id: eventId, name: 'Night Market', organizer: organizer._id, status: 'approved',
      startDateTime: new Date(Date.now() - 2 * DAY), endDateTime: new Date(Date.now() - DAY),
    });
    await Payment.create({
      user: guest._id, type: 'ticket_purchase', referenceId: eventId, referenceModel: 'Event',
      amount: 400, listedPrice: 400, platformFee: 20, gstAmount: 3.6, totalAmount: 423.6, status: 'success', paidAt: new Date(),
    });
    await User.updateOne({ _id: owner._id }, { $set: { bankDetails: { accountName: null, accountNumber: null, ifscCode: null, bankName: null } } });
    await booking(-1, 900);

    const res = await get('/api/admin/earnings/payout-queue');

    const event = res.body.rows.find((r: any) => r.id === String(eventId));
    expect(event).toMatchObject({ kind: 'event', blockedReason: 'PAN not verified', money: { outstandingAmount: 400, dueNow: 400 } });
    const venue = res.body.rows.find((r: any) => r.id === String(venueId));
    expect(venue).toMatchObject({ blockedReason: 'No bank account saved', payTo: null });
    expect(res.body.totals.blockedListings).toBe(2);

    const venuesOnly = await get('/api/admin/earnings/payout-queue?kind=venue');
    expect(venuesOnly.body.rows.every((r: any) => r.kind === 'venue')).toBe(true);
  });

  it('is refused for a moderator', async () => {
    const mod = await User.create({
      name: 'Mo', email: `${new mongoose.Types.ObjectId()}@x.test`, password: 'x',
      role: 'admin', roles: ['admin'], adminRole: 'moderator',
    });
    const res = await request(app).get('/api/admin/earnings/payout-queue').set('Authorization', `Bearer ${tokenFor(mod)}`);
    expect(res.status).toBe(403);
  });
});

describe('venue revenue figures', () => {
  it('count what guests have paid, not the price of accepted-but-unpaid bookings', async () => {
    await booking(4, 1500); // paid in full
    await booking(6, 800, false); // accepted, not paid
    const advanceOnly = await booking(8, 2000, false);
    await db().collection('bookings').updateOne({ _id: advanceOnly }, {
      $set: {
        paymentStatus: 'paid',
        paymentSchedule: { type: 'installment', depositAmount: 200, balanceAmount: 1800, balanceStatus: 'pending' },
      },
    });

    const stats = await get('/api/admin/stats');
    expect(stats.body.venueRevenue).toBe(1700);

    const venue = await get(`/api/admin/venues/${venueId}`);
    expect(venue.body.stats.totalRevenue).toBe(1700);
  });
});

describe('GET /bookings', () => {
  it('lists bookings across venues with what each guest has actually paid', async () => {
    const paid = await booking(4, 1500);
    const unpaid = await booking(6, 800, false);

    const res = await get('/api/admin/bookings');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.counts).toMatchObject({ accepted: 2 });
    const byId = Object.fromEntries(res.body.bookings.map((b: any) => [b._id, b]));
    expect(byId[String(paid)]).toMatchObject({ received: 1500, venue: { name: 'Lotus Hall', owner: { name: 'Vik Owner' } }, user: { name: 'Gita Guest' } });
    expect(byId[String(unpaid)].received).toBe(0);
  });

  it('filters by payment status, venue and search', async () => {
    await booking(4, 1500);
    await booking(6, 800, false);

    const unpaid = await get('/api/admin/bookings?paymentStatus=pending');
    expect(unpaid.body.bookings).toHaveLength(1);

    const other = await get(`/api/admin/bookings?venue=${new mongoose.Types.ObjectId()}`);
    expect(other.body.total).toBe(0);

    const byGuest = await get('/api/admin/bookings?search=gita');
    expect(byGuest.body.total).toBe(2);
    const nobody = await get('/api/admin/bookings?search=zzz');
    expect(nobody.body.total).toBe(0);
  });
});
