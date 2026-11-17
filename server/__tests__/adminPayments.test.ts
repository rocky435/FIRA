/**
 * Every payment in one list for the admin: successful, failed, refunded and
 * pending, tickets and venue bookings, with who paid and what it was for.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import './setup';

const adminService = require('../services/adminService');

const db = () => mongoose.connection.db!;
const oid = () => new mongoose.Types.ObjectId();

async function seed() {
    const priya = oid();
    const ravi = oid();
    await db().collection('users').insertMany([
        { _id: priya, name: 'Priya', email: 'priya@x.test', phone: '9876500001' },
        { _id: ravi, name: 'Ravi', email: 'ravi@x.test', phone: '9876500002' },
    ]);
    const event = oid();
    await db().collection('events').insertOne({ _id: event, name: 'Jazz Night', status: 'approved' });
    const venue = oid();
    await db().collection('venues').insertOne({ _id: venue, name: 'Lotus Hall', status: 'approved' });
    const booking = oid();
    await db().collection('bookings').insertOne({ _id: booking, venue, user: ravi, status: 'accepted', bookingDate: new Date(), startTime: '10:00', endTime: '18:00', totalAmount: 5000 });
    const at = (d: number) => new Date(Date.UTC(2026, 10, d, 10));
    await db().collection('payments').insertMany([
        { _id: oid(), user: priya, type: 'ticket', referenceModel: 'Event', referenceId: event, amount: 1000, totalAmount: 1059, status: 'success', paymentMethod: 'upi', gatewayTransactionId: 'pay_A', paidAt: at(3), createdAt: at(3) },
        { _id: oid(), user: priya, type: 'ticket', referenceModel: 'Event', referenceId: event, amount: 1000, totalAmount: 1059, status: 'failed', failureReason: 'Card declined', createdAt: at(4) },
        { _id: oid(), user: ravi, type: 'venue_booking', referenceModel: 'Booking', referenceId: booking, amount: 5000, totalAmount: 5000, status: 'success', paidAt: at(5), createdAt: at(5) },
        { _id: oid(), user: ravi, type: 'ticket', referenceModel: 'Event', referenceId: event, amount: 500, totalAmount: 500, status: 'refunded', createdAt: at(6) },
        { _id: oid(), user: ravi, type: 'ticket', referenceModel: 'Event', referenceId: event, amount: 500, totalAmount: 500, status: 'processing', createdAt: at(7) },
    ]);
    return { event, venue };
}

describe('admin payments list', () => {
    it('lists every payment newest first, with who paid and what for', async () => {
        const { event, venue } = await seed();
        const res = await adminService.getPayments({});
        expect(res.total).toBe(5);
        expect(res.payments.map((p: any) => p.status)).toEqual(['processing', 'refunded', 'success', 'failed', 'success']);
        const booking = res.payments.find((p: any) => p.kind === 'venue');
        expect(booking).toMatchObject({ amount: 5000, user: { name: 'Ravi' }, for: { name: 'Lotus Hall', link: `/venues/${venue}` } });
        const failed = res.payments.find((p: any) => p.status === 'failed');
        expect(failed).toMatchObject({ kind: 'ticket', failureReason: 'Card declined', for: { name: 'Jazz Night', link: `/events/${event}` } });
        // Counts for the tabs; pending covers processing too.
        expect(res.counts).toEqual({ all: 5, success: 2, failed: 1, refunded: 1, pending: 1 });
    });

    it('filters by status, kind and search (name, email, phone or Razorpay id)', async () => {
        await seed();
        expect((await adminService.getPayments({ status: 'failed' })).payments).toHaveLength(1);
        expect((await adminService.getPayments({ status: 'pending' })).payments).toHaveLength(1);
        expect((await adminService.getPayments({ kind: 'venue' })).payments).toHaveLength(1);
        expect((await adminService.getPayments({ search: 'priya' })).total).toBe(2);
        expect((await adminService.getPayments({ search: '9876500002' })).total).toBe(3);
        expect((await adminService.getPayments({ search: 'pay_A' })).total).toBe(1);
        // Successful money in the current view, for the header.
        expect((await adminService.getPayments({})).successTotal).toBe(6059);
    });
});
