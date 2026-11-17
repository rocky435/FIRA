/**
 * What the admin sees beyond the approval queues:
 *
 * - an alert when an event is posted that needs no admin approval (a verified
 *   organiser is fast-tracked), so nothing reaches the site unannounced;
 * - monthly events held, venue bookings and venues booked for the dashboard;
 * - the Razorpay fee taken off what was collected, and the net;
 * - twelve months of sign-ups for the Users page.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import './setup';

const adminService = require('../services/adminService');
const eventService = require('../services/eventService');
const adminAlertService = require('../services/adminAlertService');

const db = () => mongoose.connection.db!;
const oid = () => new mongoose.Types.ObjectId();

afterEach(() => vi.restoreAllMocks());

async function makeUser(name: string, extra: Record<string, unknown> = {}) {
    const _id = oid();
    await db().collection('users').insertOne({ _id, name, email: `${name}-${_id}@x.test`, role: 'user', roles: ['user'], ...extra });
    return _id;
}

describe('alerts for events that skip admin approval', () => {
    it('a fast-tracked organiser posting an event alerts the admins as "posted"', async () => {
        const notify = vi.spyOn(adminAlertService, 'notify').mockImplementation(() => {});
        const organizer = await makeUser('Priya', { isVerified: true, verificationBadge: 'brand' });
        const owner = await makeUser('Owner');
        const venue = oid();
        await db().collection('venues').insertOne({
            _id: venue, owner, name: 'Lotus Hall', status: 'approved', isActive: true, isDeleted: false,
            address: { city: 'Pune' }, capacity: { min: 1, max: 500 }, pricing: { basePrice: 1000, pricePerDay: 1000 },
        });

        await eventService.createEvent({
            organizer, venue: String(venue), name: 'Jazz Night', description: 'Live jazz', category: 'music', maxAttendees: 50,
            startDateTime: new Date(Date.now() + 20 * 864e5), endDateTime: new Date(Date.now() + 20.2 * 864e5),
        });

        const posted = notify.mock.calls.filter((c) => c[0] === 'eventPosted');
        expect(posted).toHaveLength(1);
        expect(posted[0][1].body).toContain('Jazz Night');
        expect(posted[0][1].body).toContain('Priya');
        // Not also sent as an approval alert: the admin has nothing to approve.
        expect(notify.mock.calls.filter((c) => c[0] === 'event')).toHaveLength(0);
    });

    it('an ordinary organiser does not trigger the "posted" alert', async () => {
        const notify = vi.spyOn(adminAlertService, 'notify').mockImplementation(() => {});
        const organizer = await makeUser('Ravi');
        const owner = await makeUser('Owner');
        const venue = oid();
        await db().collection('venues').insertOne({
            _id: venue, owner, name: 'Lotus Hall', status: 'approved', isActive: true, isDeleted: false,
            address: { city: 'Pune' }, capacity: { min: 1, max: 500 }, pricing: { basePrice: 1000, pricePerDay: 1000 },
        });
        await eventService.createEvent({
            organizer, venue: String(venue), name: 'Rock Night', description: 'Rock', category: 'music', maxAttendees: 50,
            startDateTime: new Date(Date.now() + 20 * 864e5), endDateTime: new Date(Date.now() + 20.2 * 864e5),
        });
        expect(notify.mock.calls.filter((c) => c[0] === 'eventPosted')).toHaveLength(0);
    });

    it('both new kinds are known to the alert service', () => {
        expect(adminAlertService.KINDS.eventPosted).toBeTruthy();
        expect(adminAlertService.KINDS.venueListed).toBeTruthy();
    });
});

describe('dashboard trends — events held and venue bookings', () => {
    it('counts events that took place and venue bookings by month', async () => {
        const now = new Date('2026-11-15T10:00:00.000Z');
        const ev = (status: string, start: string, extra = {}) => ({
            _id: oid(), name: 'E', status, startDateTime: new Date(start), endDateTime: new Date(new Date(start).getTime() + 3 * 3600e3), ...extra,
        });
        await db().collection('events').insertMany([
            ev('completed', '2026-10-05T12:00:00Z'),
            ev('completed', '2026-10-20T12:00:00Z'),
            ev('approved', '2026-11-10T12:00:00Z'),
            ev('approved', '2026-11-25T12:00:00Z'), // later this month: not held yet
            ev('cancelled', '2026-11-08T12:00:00Z'),
            ev('pending', '2026-11-09T12:00:00Z'),
            ev('completed', '2026-11-03T12:00:00Z', { isDeleted: true }),
        ]);
        const hall = oid();
        const lawn = oid();
        const bk = (venue: mongoose.Types.ObjectId, status: string, day: string) => ({
            _id: oid(), venue, user: oid(), status, bookingDate: new Date(`${day}T00:00:00Z`), startTime: '10:00', endTime: '18:00', totalAmount: 1000,
        });
        await db().collection('bookings').insertMany([
            bk(hall, 'completed', '2026-10-02'),
            bk(hall, 'accepted', '2026-10-09'),
            bk(lawn, 'accepted', '2026-10-30'),
            bk(hall, 'accepted', '2026-11-12'),
            bk(lawn, 'cancelled', '2026-11-05'),
            bk(lawn, 'pending', '2026-11-06'),
            bk(lawn, 'accepted', '2026-11-28'), // later this month: not happened yet
        ]);

        const trends = await adminService.getTrends(now);
        const oct = trends.find((t: any) => t.month === '2026-10');
        const nov = trends.find((t: any) => t.month === '2026-11');
        expect(oct).toMatchObject({ eventsHeld: 2, venueBookings: 3, venuesBooked: 2 });
        expect(nov).toMatchObject({ eventsHeld: 1, venueBookings: 1, venuesBooked: 1 });
    });
});

describe('Razorpay fee on what was collected', () => {
    it('takes the fee (2.36% by default: 2% + 18% GST) off the collected total', async () => {
        await db().collection('tickets').insertOne({ _id: oid(), ticketId: 'T1', user: oid(), event: oid(), price: 1000, quantity: 1, status: 'active' });
        const stats = await adminService.getStats();
        expect(stats.totalRevenue).toBe(1000);
        expect(stats.gatewayFeePercent).toBe(2.36);
        expect(stats.gatewayFee).toBe(23.6);
        expect(stats.netRevenue).toBe(976.4);
    });

    it('event, venue and creator pages carry the fee on what buyers actually paid', async () => {
        const organizer = await makeUser('Org');
        const event = oid();
        await db().collection('events').insertOne({ _id: event, name: 'Gig', organizer, status: 'approved', startDateTime: new Date(), endDateTime: new Date() });
        // Full price 1000 each; one buyer used a discount, both paid the booking fee.
        await db().collection('tickets').insertMany([
            { _id: oid(), ticketId: 'A', user: oid(), event, price: 1000, quantity: 1, status: 'active' },
            { _id: oid(), ticketId: 'B', user: oid(), event, price: 1000, quantity: 1, status: 'active' },
        ]);
        await db().collection('payments').insertMany([
            { _id: oid(), user: oid(), type: 'ticket', referenceModel: 'Event', referenceId: event, amount: 1050, totalAmount: 1050, status: 'success' },
            { _id: oid(), user: oid(), type: 'ticket', referenceModel: 'Event', referenceId: event, amount: 950, totalAmount: 950, status: 'success' },
            { _id: oid(), user: oid(), type: 'ticket', referenceModel: 'Event', referenceId: event, amount: 999, totalAmount: 999, status: 'failed' },
        ]);
        const ev = await adminService.getEventById(String(event));
        expect(ev.stats.totalRevenue).toBe(2000); // full price, unchanged
        expect(ev.stats.collected).toBe(2000);
        expect(ev.stats.gatewayFee).toBe(47.2);
        expect(ev.stats.afterGateway).toBe(1952.8);

        const brand = oid();
        await db().collection('brandprofiles').insertOne({ _id: brand, user: organizer, name: 'Neon', type: 'brand', status: 'approved' });
        const br = await adminService.getBrandById(String(brand));
        expect(br.stats.collected).toBe(2000);
        expect(br.stats.afterGateway).toBe(1952.8);

        const owner = await makeUser('Owner');
        const venue = oid();
        await db().collection('venues').insertOne({ _id: venue, owner, name: 'Hall', status: 'approved' });
        await db().collection('bookings').insertOne({
            _id: oid(), venue, user: oid(), status: 'accepted', paymentStatus: 'paid', totalAmount: 5000,
            paymentSchedule: { type: 'full' }, bookingDate: new Date(), startTime: '10:00', endTime: '18:00',
        });
        const vn = await adminService.getVenueById(String(venue));
        expect(vn.stats.totalRevenue).toBe(5000);
        expect(vn.stats.gatewayFee).toBe(118);
        expect(vn.stats.afterGateway).toBe(4882);
        expect(vn.stats.gatewayFeePercent).toBe(2.36);
    });

    it('the rate is available to the admin app', () => {
        expect(adminService.getGatewayFee()).toEqual({ percent: 2.36 });
    });
});

describe('sign-ups for the Users page', () => {
    it('gives twelve months, oldest first, with this month and the total', async () => {
        const now = new Date('2026-11-15T10:00:00.000Z');
        await db().collection('users').insertMany([
            { _id: oid(), name: 'a', email: 'a@x.test', createdAt: new Date('2026-11-02T10:00:00Z') },
            { _id: oid(), name: 'b', email: 'b@x.test', createdAt: new Date('2026-11-03T10:00:00Z') },
            { _id: oid(), name: 'c', email: 'c@x.test', createdAt: new Date('2026-10-03T10:00:00Z') },
            { _id: oid(), name: 'd', email: 'd@x.test', createdAt: new Date('2025-01-03T10:00:00Z') },
        ]);
        const s = await adminService.getSignups(now);
        expect(s.months).toHaveLength(12);
        expect(s.months[0].month).toBe('2025-12');
        expect(s.months[11]).toEqual({ month: '2026-11', newUsers: 2 });
        expect(s.months[10]).toEqual({ month: '2026-10', newUsers: 1 });
        expect(s.total).toBe(4);
    });
});
