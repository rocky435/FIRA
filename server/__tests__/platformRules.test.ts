/**
 * Platform rules agreed with the owner (Oct 2026), each pinned by a test:
 *
 * - Venue owners cannot set the platform fee, approval, verification or rating
 *   (including through dotted keys like "rating.average"); brands likewise.
 * - Creators can edit/delete their own posts; commenters can delete their own comments.
 * - Only approved, active, undeleted venues can be booked.
 * - Private events: never listed, the code only reaches the organizer, and the
 *   server checks the code before selling a ticket.
 * - Accounts with anything upcoming cannot be deleted; events with sold tickets
 *   and venues with upcoming bookings go to an admin for removal.
 * - Changing payout details needs the account password.
 * - Bookings: the guest sends a request (nothing paid); the owner accepts or
 *   rejects within 48 hours or it expires; once accepted the guest pays the 10%
 *   advance or the full amount within 48 hours or it is cancelled; the rest of
 *   an advance is paid in the app; a final notice two days before if the rest is
 *   unpaid, a "tomorrow" reminder the day before if fully paid. Requests paid
 *   under the old flow: rejection refunds, unanswered ones expire with a refund.
 * - Cancelling an event frees the venue's days.
 * - Ticket sales are written to the audit trail; payment records and the audit
 *   trail cannot be deleted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.RAZORPAY_KEY_SECRET = 'rzp-test-secret';
delete process.env.REDIS_HOST;
delete process.env.RAZORPAY_KEY_ID;

const Venue = require('../models/Venue');
const Event = require('../models/Event');
const Ticket = require('../models/Ticket');
const Booking = require('../models/Booking');
const BrandProfile = require('../models/BrandProfile');
const Post = require('../models/Post');
const Payment = require('../models/Payment');
const Refund = require('../models/Refund');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const eventService = require('../services/eventService');
const bookingService = require('../services/bookingService');
const jobs = require('../jobs/scheduledJobs');

let app: express.Express;
const tokens: Record<string, string> = {};
const bearer = (id: string) => `Bearer ${tokens[id]}`;
const PASSWORD = 'Passw0rd!x';

async function makeUser(name: string, roles: string[] = ['user'], extra: Record<string, any> = {}) {
    const _id = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('users').insertOne({
        _id, name, email: `${name}@x.test`, password: await bcrypt.hash(PASSWORD, 4),
        role: roles[0], roles, emailVerified: true, ...extra,
    });
    const id = _id.toString();
    tokens[id] = jwt.sign({ userId: id, role: roles[0] }, process.env.JWT_SECRET!);
    return id;
}

const venueBody = (overrides: Record<string, any> = {}) => ({
    name: 'Hall', description: 'd', capacity: { min: 1, max: 100 },
    pricing: { basePrice: 10000, pricePerDay: 10000 },
    address: { street: 's', city: 'Hyderabad', state: 'TS', pincode: '500001' },
    ...overrides,
});
const inDays = (n: number) => new Date(Date.now() + n * 86400000);
/** The calendar day n days from today, as the client sends it ('YYYY-MM-DD' -> UTC midnight). */
const dayOut = (n: number) => {
    const d = inDays(n);
    return new Date(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00:00Z`);
};
const sign = (orderId: string, payId: string) =>
    crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!).update(`${orderId}|${payId}`).digest('hex');

beforeEach(async () => {
    app = express();
    app.use(express.json());
    for (const [p, m] of [['venues', '../routes/venue'], ['brands', '../routes/brand'], ['events', '../routes/event'],
        ['bookings', '../routes/booking'], ['tickets', '../routes/ticket'], ['users', '../routes/user'], ['admin', '../routes/admin']]) {
        const r = await import(m);
        app.use(`/${p}`, (r as any).default || r);
    }
});

describe('listings', () => {
    it('a venue owner cannot create an approved, 0%-fee, pre-rated venue', async () => {
        const owner = await makeUser('owner', ['venue_owner']);
        const res = await request(app).post('/venues').set('Authorization', bearer(owner))
            .send(venueBody({ status: 'approved', isVerified: true, platformFeePercentage: 0, rating: { average: 5, count: 999 } }));
        expect(res.status).toBe(201);
        const v = await Venue.findById(res.body._id).lean();
        expect({ status: v.status, fee: v.platformFeePercentage, rating: v.rating.average, owner: String(v.owner) })
            .toEqual({ status: 'pending', fee: 5, rating: 0, owner });
    });

    it('a venue owner cannot set the fee or a rating on update, dotted keys included', async () => {
        const owner = await makeUser('owner', ['venue_owner']);
        const v = await Venue.create({ owner, ...venueBody() });
        await request(app).put(`/venues/${v._id}`).set('Authorization', bearer(owner))
            .send({ platformFeePercentage: 0, 'rating.average': 5, name: 'Renamed' });
        const after = await Venue.findById(v._id).lean();
        expect({ fee: after.platformFeePercentage, rating: after.rating.average, name: after.name }).toEqual({ fee: 5, rating: 0, name: 'Renamed' });
    });

    it('a brand cannot fake its follower count', async () => {
        const u = await makeUser('creator');
        await request(app).post('/brands').set('Authorization', bearer(u)).send({ name: 'B', type: 'brand' });
        await request(app).post('/brands').set('Authorization', bearer(u)).send({ 'stats.followers': 1000000 });
        expect((await BrandProfile.findOne({ user: u }).lean()).stats?.followers || 0).toBe(0);
    });

    it('a creator edits and deletes their own post; a commenter deletes their own comment', async () => {
        const u = await makeUser('creator');
        const c = await makeUser('fan');
        const brand = await BrandProfile.create({ user: u, name: 'B', type: 'brand', status: 'approved' });
        const post = await Post.create({ brand: brand._id, author: u, content: 'hello', comments: [{ user: c, content: 'hi' }] });
        const commentId = (await Post.findById(post._id).lean()).comments[0]._id;
        expect((await request(app).put(`/brands/${brand._id}/posts/${post._id}`).set('Authorization', bearer(u)).send({ content: 'edited' })).status).toBe(200);
        expect((await request(app).delete(`/brands/${brand._id}/posts/${post._id}/comments/${commentId}`).set('Authorization', bearer(c))).status).toBe(200);
        expect((await request(app).delete(`/brands/${brand._id}/posts/${post._id}`).set('Authorization', bearer(u))).status).toBe(200);
    });

    it('only approved, live venues can be booked or opened by the public', async () => {
        const owner = await makeUser('owner', ['venue_owner']);
        const guest = await makeUser('guest');
        const v = await Venue.create({ owner, ...venueBody(), status: 'suspended' });
        const res = await request(app).post('/bookings').set('Authorization', bearer(guest)).send({
            venue: v._id, bookingDate: inDays(20).toISOString().slice(0, 10), startTime: '10:00', endTime: '14:00', expectedGuests: 10, purpose: 'party',
        });
        expect(res.status).toBe(400);
        expect((await request(app).get(`/venues/${v._id}`)).status).toBe(404);
        expect((await request(app).get(`/venues/${v._id}`).set('Authorization', bearer(owner))).status).toBe(200);
    });
});

describe('private events', () => {
    async function privateEvent(org: string, extra: Record<string, any> = {}) {
        return Event.create({ organizer: org, name: 'Secret', description: 'd', maxAttendees: 10, eventType: 'private',
            privateCode: 'ABCD1234', status: 'approved', adminApproval: { status: 'approved' }, ticketPrice: 0,
            startDateTime: inDays(1), endDateTime: inDays(1.1), ...extra });
    }

    it('are never listed, and only the organizer sees the code', async () => {
        const org = await makeUser('org');
        const ev = await privateEvent(org);
        expect(JSON.stringify((await request(app).get('/events')).body)).not.toContain('Secret');
        expect(JSON.stringify((await request(app).get('/events?eventType=private')).body)).not.toContain('Secret');
        const byLink = await request(app).get(`/events/${ev._id}`);
        expect(byLink.status).toBe(200);
        expect(byLink.body.privateCode).toBeUndefined();
        const own = await request(app).get(`/events/${ev._id}`).set('Authorization', bearer(org));
        expect(own.body.privateCode).toBe('ABCD1234');
        const ownList = await request(app).get(`/events?organizer=${org}`).set('Authorization', bearer(org));
        expect(JSON.stringify(ownList.body)).toContain('Secret');
    });

    it('the server checks the code, and tickets need it', async () => {
        const org = await makeUser('org');
        const buyer = await makeUser('buyer');
        const ev = await privateEvent(org);
        expect((await request(app).post(`/events/${ev._id}/verify-code`).send({ code: 'WRONG' })).status).toBe(400);
        expect((await request(app).post(`/events/${ev._id}/verify-code`).send({ code: 'abcd1234' })).status).toBe(200);
        const noCode = await request(app).post('/tickets').set('Authorization', bearer(buyer)).send({ eventId: ev._id, quantity: 1 });
        expect(noCode.status).not.toBe(201);
        const withCode = await request(app).post('/tickets').set('Authorization', bearer(buyer)).send({ eventId: ev._id, quantity: 1, accessCode: 'ABCD1234' });
        expect(withCode.status).toBe(201);

        // Every sale lands on the audit trail, under the buyer.
        await new Promise(r => setTimeout(r, 50));
        const sale = await AuditLog.findOne({ action: 'sale', entityType: 'ticket' }).lean();
        expect(String(sale.adminUser)).toBe(buyer);
        expect(sale.metadata).toMatchObject({ name: 'Secret', quantity: 1, amountPaid: 0 });
    });
});

describe('removing things customers paid for', () => {
    it('an account with anything upcoming cannot be deleted, and is told what', async () => {
        const org = await makeUser('org');
        const ev = await Event.create({ organizer: org, name: 'Gig', description: 'd', maxAttendees: 10, status: 'approved',
            startDateTime: inDays(1), endDateTime: inDays(1.1) });
        const check = await request(app).get('/users/me/deletion-check').set('Authorization', bearer(org));
        expect(check.body.canDelete).toBe(false);
        expect(check.body.blockers.events[0].name).toBe('Gig');
        const del = await request(app).delete('/users/me').set('Authorization', bearer(org));
        expect(del.status).toBe(409);
        expect(await Event.exists({ _id: ev._id })).toBeTruthy();

        const free = await makeUser('free');
        expect((await request(app).delete('/users/me').set('Authorization', bearer(free))).status).toBe(200);
    });

    it('an organizer with sold tickets sends removal to an admin; the admin removal cancels and raises refunds', async () => {
        const org = await makeUser('org');
        const buyer = await makeUser('buyer');
        const admin = await makeUser('admin', ['admin'], { adminRole: 'admin' });
        const ev = await Event.create({ organizer: org, name: 'Gig', description: 'd', maxAttendees: 10, status: 'approved',
            startDateTime: inDays(10), endDateTime: inDays(10.1), currentAttendees: 1 });
        const pay = await Payment.create({ user: buyer, type: 'ticket', referenceId: ev._id, referenceModel: 'Event', status: 'success',
            amount: 529.5, subtotal: 500, totalAmount: 529.5, gatewayTransactionId: 'pay_t' });
        await Ticket.create({ user: buyer, event: ev._id, ticketId: 'TKT-1', quantity: 1, price: 500, payment: pay._id, status: 'active' });

        for (const call of [request(app).delete(`/events/${ev._id}`), request(app).post(`/events/${ev._id}/cancel`)]) {
            const res = await call.set('Authorization', bearer(org)).send({ reason: 'Venue issue' });
            expect(res.status).toBe(202);
        }
        const requested = await Event.findById(ev._id).lean();
        expect(requested.deletionRequest.requestedAt).toBeTruthy();
        expect(requested.isDeleted).not.toBe(true);
        expect((await Ticket.findOne({ ticketId: 'TKT-1' }).lean()).status).toBe('active');

        const res = await request(app).delete(`/admin/events/${ev._id}`).set('Authorization', bearer(admin));
        expect(res.status).toBe(200);
        expect((await Ticket.findOne({ ticketId: 'TKT-1' }).lean()).status).toBe('cancelled');
        const refunds = await Refund.find({ payment: pay._id }).lean();
        expect(refunds).toHaveLength(1);
        expect(refunds[0].amount).toBe(500);
        expect(refunds[0].status).toBe('pending');
    });

    it('a venue with upcoming bookings goes to an admin; an admin cannot remove one with upcoming events', async () => {
        const owner = await makeUser('owner', ['venue_owner']);
        const guest = await makeUser('guest');
        const admin = await makeUser('admin', ['admin'], { adminRole: 'admin' });
        const v = await Venue.create({ owner, ...venueBody(), status: 'approved' });
        await Booking.create({ user: guest, venue: v._id, bookingDate: inDays(15), startTime: '10:00', endTime: '14:00', totalAmount: 10000, status: 'pending' });
        expect((await request(app).delete(`/venues/${v._id}`).set('Authorization', bearer(owner))).status).toBe(202);
        expect((await Venue.findById(v._id).lean()).isDeleted).not.toBe(true);

        await Event.create({ organizer: guest, venue: v._id, name: 'Party', description: 'd', maxAttendees: 10, status: 'approved',
            startDateTime: inDays(20), endDateTime: inDays(20.1) });
        expect((await request(app).delete(`/admin/venues/${v._id}`).set('Authorization', bearer(admin))).status).toBe(409);
    });
});

describe('payout details need the password once they exist', () => {
    it('first account needs none; changes after that do', async () => {
        const u = await makeUser('payee');
        const acct = (n: string) => ({ accountName: 'Payee', accountNumber: n, ifscCode: 'HDFC0001234', bankName: 'HDFC' });
        expect((await request(app).post('/users/me/bank-accounts').set('Authorization', bearer(u)).send(acct('123456789012'))).status).toBe(201);
        expect((await request(app).post('/users/me/bank-accounts').set('Authorization', bearer(u)).send(acct('999988887777'))).status).toBe(403);
        expect((await request(app).post('/users/me/bank-accounts').set('Authorization', bearer(u)).send({ ...acct('999988887777'), currentPassword: 'wrong' })).status).toBe(403);
        expect((await request(app).post('/users/me/bank-accounts').set('Authorization', bearer(u)).send({ ...acct('999988887777'), currentPassword: PASSWORD })).status).toBe(201);
    });
});

describe('booking flow: request, owner accepts, then the guest pays', () => {
    async function setup(daysOut = 30, extra: Record<string, any> = {}) {
        const owner = await makeUser('owner', ['venue_owner']);
        const guest = await makeUser('guest');
        const venue = await Venue.create({ owner, ...venueBody(), status: 'approved' });
        const bookingDate = dayOut(daysOut);
        const booking = await Booking.create({
            user: guest, venue: venue._id, bookingDate, startTime: '18:00', endTime: '22:00', totalAmount: 10000,
            status: 'pending', paymentSchedule: { type: 'installment', depositAmount: 1000, balanceAmount: 9000, balanceStatus: 'pending',
                balanceDueAt: new Date(new Date(bookingDate).setHours(18, 0, 0, 0) - 86400000) }, ...extra,
        });
        return { owner, guest, venue, booking };
    }
    async function pay(booking: any, guest: string, subtotal: number, id = 'pay_adv') {
        const order = `order_${booking._id}_${id}`;
        await Payment.create({ user: guest, type: 'venue_booking', referenceId: booking._id, referenceModel: 'Booking', status: 'pending',
            amount: subtotal * 1.059, subtotal, totalAmount: subtotal * 1.059, gatewayOrderId: order });
        return bookingService.completeBookingPayment(booking._id, {
            gatewayOrderId: order, gatewayPaymentId: id, gatewaySignature: sign(order, id),
        });
    }
    const accept = (owner: string, booking: any) =>
        request(app).put(`/bookings/${booking._id}/status`).set('Authorization', bearer(owner)).send({ status: 'accepted' });

    it('a request is sent without paying, and the owner has 48 hours to answer', async () => {
        const owner = await makeUser('owner', ['venue_owner']);
        const guest = await makeUser('guest');
        const venue = await Venue.create({ owner, ...venueBody(), status: 'approved' });
        const res = await request(app).post('/bookings').set('Authorization', bearer(guest)).send({
            venue: venue._id, bookingDate: dayOut(30).toISOString().slice(0, 10), startTime: '18:00', endTime: '22:00',
            purpose: 'Party', expectedGuests: 20, totalAmount: 1,
        });
        expect(res.status).toBe(201);
        const b = await Booking.findById(res.body._id).lean();
        expect(b.status).toBe('pending');
        expect(b.paymentStatus).toBe('pending');
        const hours = (new Date(b.ownerResponse.respondBy).getTime() - Date.now()) / 3600000;
        expect(hours).toBeGreaterThan(47.9);
        expect(hours).toBeLessThanOrEqual(48);
        await expect(bookingService.initiateBookingPayment(b._id, guest)).rejects.toThrow('not accepted');
    });

    it('once accepted the guest pays the 10% advance, and the rest stays due', async () => {
        const { owner, guest, booking } = await setup();
        const res = await accept(owner, booking);
        expect(res.status).toBe(200);
        const accepted = await Booking.findById(booking._id).lean();
        expect(accepted.status).toBe('accepted');
        const hours = (new Date(accepted.paymentDueAt).getTime() - Date.now()) / 3600000;
        expect(hours).toBeGreaterThan(47.9);

        const result = await pay(booking, guest, 1000);
        expect(await Notification.exists({ user: guest, title: 'Booking accepted - pay to confirm' })).toBeTruthy();
        expect(result.booking.paymentStatus).toBe('paid');
        expect(result.booking.paymentSchedule.type).toBe('installment');
        expect(result.booking.paymentSchedule.balanceStatus).toBe('pending');
        expect(result.booking.paymentSchedule.balanceAmount).toBe(9000);
        expect(await Notification.exists({ user: owner, type: 'payment_success' })).toBeTruthy();
    });

    it('the rest cannot be paid before the advance', async () => {
        const { owner, guest, booking } = await setup();
        await accept(owner, booking);
        // Accepted and unpaid: the schedule already names the balance, but nothing
        // is due on it until the advance has confirmed the booking.
        await expect(bookingService.initiateBalancePayment(booking._id, guest)).rejects.toThrow('advance');
        const after = await pay(booking, guest, 1000);
        expect(after.booking.paymentStatus).toBe('paid');
        // Past the guard now (it goes on to create the gateway order, which has
        // no credentials in tests).
        const err = await bookingService.initiateBalancePayment(booking._id, guest).catch((e: Error) => e);
        expect(String(err?.message || '')).not.toMatch(/advance/);
    });

    it('or pays in full, and nothing is left to pay', async () => {
        const { owner, guest, booking } = await setup();
        await accept(owner, booking);
        const result = await pay(booking, guest, 10000);
        expect(result.booking.paymentSchedule.type).toBe('full');
        expect(result.booking.paymentSchedule.balanceStatus).toBe('not_applicable');
        await expect(bookingService.initiateBalancePayment(booking._id, guest)).rejects.toThrow('No balance');
    });

    it('an accepted booking not paid in time is cancelled, and a payment arriving after that is raised for a refund', async () => {
        const { owner, guest, venue, booking } = await setup();
        await accept(owner, booking);
        expect((await Venue.findById(venue._id).lean()).blockedDates).toHaveLength(1);
        await Booking.updateOne({ _id: booking._id }, { $set: { paymentDueAt: new Date(Date.now() - 3600000) } });
        await jobs.enforceBalanceDeadlines();
        const after = await Booking.findById(booking._id).lean();
        expect(after.status).toBe('cancelled');
        expect(after.cancellationReason).toBe('payment_not_received');
        expect((await Venue.findById(venue._id).lean()).blockedDates).toEqual([]);

        const late = await pay(booking, guest, 1000);
        expect(late.booking.status).toBe('cancelled');
        expect((await Refund.find({ user: guest }).lean()).map((r: any) => [r.amount, r.status])).toEqual([[1000, 'pending']]);
    });

    it('a request the owner does not answer in time expires, with nothing to refund', async () => {
        const { guest, booking } = await setup();
        await Booking.updateOne({ _id: booking._id }, { $set: { 'ownerResponse.respondBy': new Date(Date.now() - 60000) } });
        await jobs.enforceBalanceDeadlines();
        const after = await Booking.findById(booking._id).lean();
        expect(after.status).toBe('cancelled');
        expect(after.cancellationReason).toBe('venue_did_not_respond');
        expect(await Refund.countDocuments({})).toBe(0);
        expect(await Notification.exists({ user: guest, title: 'Booking request expired' })).toBeTruthy();
    });

    it('a request paid under the old flow: rejecting it refunds the advance and frees the dates', async () => {
        const { owner, guest, venue, booking } = await setup();
        await pay(booking, guest, 1000);
        const res = await request(app).put(`/bookings/${booking._id}/status`).set('Authorization', bearer(owner)).send({ status: 'rejected', reason: 'Closed' });
        expect(res.status).toBe(200);
        const refunds = await Refund.find({ user: guest }).lean();
        expect(refunds.map((r: any) => [r.amount, r.status])).toEqual([[1000, 'pending']]);
        expect((await Venue.findById(venue._id).lean()).blockedDates).toEqual([]);
    });

    it('two days before, an unpaid balance gets one final notice instead of the daily reminder', async () => {
        const { guest, booking } = await setup(2, { paymentStatus: 'paid' });
        await jobs.sendBalanceReminders();
        expect(await Notification.countDocuments({ user: guest })).toBe(0); // not accepted: nothing

        await Booking.updateOne({ _id: booking._id }, { $set: { status: 'accepted' } });
        await jobs.sendBalanceReminders();
        await jobs.sendBalanceReminders();
        const notices = await Notification.find({ user: guest, type: 'balance_due_reminder' }).lean();
        expect(notices.map((n: any) => n.title)).toEqual(['Final notice: pay or cancel']);
    });

    it('three days before, only the daily reminder', async () => {
        const { guest } = await setup(3, { paymentStatus: 'paid', status: 'accepted' });
        await jobs.sendBalanceReminders();
        const notices = await Notification.find({ user: guest, type: 'balance_due_reminder' }).lean();
        expect(notices.map((n: any) => n.title)).toEqual(['Balance payment due']);
    });

    it('the day before, a fully paid booking gets one "tomorrow" reminder; an unpaid balance does not', async () => {
        const paid = await setup(1, { paymentStatus: 'paid', status: 'accepted' });
        await Booking.updateOne({ _id: paid.booking._id }, { $set: { 'paymentSchedule.balanceStatus': 'paid' } });
        // Same day, another venue, balance still unpaid.
        const unpaidGuest = await makeUser('guest2');
        const otherVenue = await Venue.create({ owner: paid.owner, ...venueBody(), status: 'approved' });
        const { _id, ...fields } = paid.booking.toObject();
        await Booking.create({ ...fields, user: unpaidGuest, venue: otherVenue._id });

        await jobs.sendBalanceReminders();
        await jobs.sendBalanceReminders();
        expect(await Notification.countDocuments({ user: paid.guest, title: 'Your booking is tomorrow' })).toBe(1);
        expect(await Notification.countDocuments({ user: unpaidGuest, title: 'Your booking is tomorrow' })).toBe(0);
        void _id;
    });

    it('an unpaid or future booking cannot be marked completed (no free fake reviews)', async () => {
        const { owner, guest, booking } = await setup();
        await accept(owner, booking);
        const complete = () => request(app).put(`/bookings/${booking._id}/status`).set('Authorization', bearer(owner)).send({ status: 'completed' });
        expect((await complete()).status).toBe(400);
        const review = await request(app).post(`/venues/${booking.venue}/reviews`).set('Authorization', bearer(guest)).send({ rating: 5, comment: 'Great' });
        expect(review.status).toBe(403);

        await pay(booking, guest, 10000);
        expect((await complete()).status).toBe(400); // paid, but it has not happened yet
        await Booking.updateOne({ _id: booking._id }, { $set: { bookingDate: dayOut(-1) } });
        expect((await complete()).status).toBe(200);
    });

    it('a paid request the owner never answers expires 24h before with a full refund, not a forfeit', async () => {
        const { guest, booking } = await setup(0.5, { paymentStatus: 'paid', payment: (await Payment.create({
            user: new mongoose.Types.ObjectId(), type: 'venue_booking', referenceModel: 'Booking', referenceId: new mongoose.Types.ObjectId(),
            amount: 1059, subtotal: 1000, totalAmount: 1059, status: 'success', gatewayTransactionId: 'pay_x' }))._id });
        // Starts in 6 hours: bookingDate and startTime describe the same moment.
        const start = new Date(Date.now() + 6 * 3600000);
        await Booking.updateOne({ _id: booking._id }, { $set: { bookingDate: start, startTime: start.toTimeString().slice(0, 5) } });
        await jobs.enforceBalanceDeadlines();
        const after = await Booking.findById(booking._id).lean();
        expect(after.status).toBe('cancelled');
        expect(after.cancellationReason).toBe('venue_did_not_respond');
        expect(after.paymentSchedule.balanceStatus).not.toBe('forfeited');
        expect(await Refund.countDocuments({ status: 'pending', amount: 1000 })).toBe(1);
        void guest;
    });
});

describe('venue prices and requests', () => {
    const request30 = (guest: string, venue: any, day: number) => request(app).post('/bookings').set('Authorization', bearer(guest)).send({
        venue: venue._id, bookingDate: dayOut(day).toISOString().slice(0, 10), startTime: '18:00', endTime: '22:00', purpose: 'Party', expectedGuests: 10,
    });

    it('a venue cannot be listed or priced at 0', async () => {
        const owner = await makeUser('owner', ['venue_owner']);
        const zero = await request(app).post('/venues').set('Authorization', bearer(owner)).send(venueBody({ pricing: { pricePerDay: 0, basePrice: 0 } }));
        expect(zero.status).toBe(400);
        const ok = await request(app).post('/venues').set('Authorization', bearer(owner)).send(venueBody());
        expect(ok.status).toBe(201);
        const dotted = await request(app).put(`/venues/${ok.body._id}`).set('Authorization', bearer(owner)).send({ 'pricing.pricePerDay': 0 });
        expect((await Venue.findById(ok.body._id).lean()).pricing.pricePerDay).toBe(10000);
        void dotted;
        const zeroUpdate = await request(app).put(`/venues/${ok.body._id}`).set('Authorization', bearer(owner)).send({ pricing: { pricePerDay: 0 } });
        expect(zeroUpdate.status).not.toBe(200);
    });

    it('each day is charged at its own rate: special date, then weekend, then the day rate', async () => {
        const owner = await makeUser('owner', ['venue_owner']);
        const guest = await makeUser('guest');
        // Find the next Friday at least 30 days out, so the booking covers Fri, Sat, Sun.
        let friday = 30;
        while (dayOut(friday).getUTCDay() !== 5) friday++;
        const sunday = dayOut(friday + 2).toISOString().slice(0, 10);
        const venue = await Venue.create({ owner, ...venueBody({ pricing: {
            pricePerDay: 10000, basePrice: 10000, weekendPricePerDay: 15000, specialDates: [{ date: sunday, pricePerDay: 30000 }],
        } }), status: 'approved' });
        const res = await request(app).post('/bookings').set('Authorization', bearer(guest)).send({
            venue: venue._id, bookingDate: dayOut(friday).toISOString().slice(0, 10), endDate: sunday,
            startTime: '18:00', endTime: '22:00', purpose: 'Wedding', expectedGuests: 10, totalAmount: 1,
        });
        expect(res.status).toBe(201);
        expect(res.body.totalAmount).toBe(10000 + 15000 + 30000);
    });

    it('one person can have at most 3 unpaid requests open', async () => {
        const owner = await makeUser('owner', ['venue_owner']);
        const guest = await makeUser('guest');
        const venue = await Venue.create({ owner, ...venueBody(), status: 'approved' });
        for (const day of [30, 31, 32]) expect((await request30(guest, venue, day)).status).toBe(201);
        const fourth = await request30(guest, venue, 33);
        expect(fourth.status).toBe(400);
        expect(fourth.body.error).toContain('3 booking requests');
        // Withdrawing one frees a slot.
        const open = await Booking.findOne({ user: guest }).lean();
        await request(app).post(`/bookings/${open._id}/cancel`).set('Authorization', bearer(guest)).send({});
        expect((await request30(guest, venue, 33)).status).toBe(201);
    });
});

describe('events and the venue calendar', () => {
    it('cancelling an approved event frees its days and its venue booking', async () => {
        const owner = await makeUser('owner', ['venue_owner']);
        const org = await makeUser('org');
        const venue = await Venue.create({ owner, ...venueBody(), status: 'approved' });
        const start = new Date(dayOut(20).getTime() + 12.5 * 3600000);
        const ev = await Event.create({ organizer: org, venue: venue._id, name: 'Gig', description: 'd', maxAttendees: 10, status: 'approved',
            startDateTime: start, endDateTime: new Date(start.getTime() + 4 * 3600000) });
        await eventService.updateVenueAvailability(ev);
        await eventService.holdVenueForEvent(ev);
        const held = await Venue.findById(venue._id).lean();
        expect(held.blockedDates).toHaveLength(1);
        expect(held.daySlots.filter((d: any) => d.isBooked)).toHaveLength(1);

        await eventService.cancelEvent(ev._id, 'Rain');
        const freed = await Venue.findById(venue._id).lean();
        expect(freed.blockedDates).toEqual([]);
        expect(freed.daySlots.filter((d: any) => d.isBooked)).toEqual([]);
        expect((await Booking.findOne({ event: ev._id }).lean()).status).toBe('cancelled');
    });
});

describe('records are permanent', () => {
    it('there is no route to wipe payments or delete the audit trail', async () => {
        const admin = await makeUser('sup', ['admin'], { adminRole: 'super_admin' });
        for (const path of ['/admin/wipe-payment-data', '/admin/audit-trail/all', `/admin/audit-trail/${new mongoose.Types.ObjectId()}`]) {
            expect((await request(app).delete(path).set('Authorization', bearer(admin))).status).toBe(404);
        }
    });
});
