/**
 * The admin's refund list carries why each refund exists: the booking (venue,
 * date, why it was cancelled) or the tickets and their event that the money
 * paid for, the customer's phone and earlier refunds, and who decided it.
 * The list used to show only the amount, the customer and the raw payment.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import './setup';

const refundService = require('../services/refundService');

const db = () => mongoose.connection.db!;
const oid = () => new mongoose.Types.ObjectId();

async function insert(collection: string, doc: Record<string, unknown>) {
    const _id = oid();
    await db().collection(collection).insertOne({ _id, createdAt: new Date(), updatedAt: new Date(), ...doc });
    return _id;
}

describe('refund list context', () => {
    it('explains a booking refund and a ticket refund', async () => {
        const guest = await insert('users', { name: 'Asha', email: 'asha@x.test', phone: '9876543210', role: 'user', roles: ['user'] });
        const admin = await insert('users', { name: 'Ravi Admin', email: 'ravi@x.test', role: 'admin', roles: ['admin'] });
        const organizer = await insert('users', { name: 'Neon Events', email: 'neon@x.test', role: 'user', roles: ['user'] });
        const venue = await insert('venues', { name: 'Lotus Hall', address: { city: 'Pune' }, status: 'approved' });

        // A venue booking the guest cancelled.
        const bookingPay = await insert('payments', { user: guest, type: 'venue_booking', referenceModel: 'Booking', referenceId: oid(), amount: 5000, totalAmount: 5000, status: 'success' });
        await insert('bookings', {
            user: guest, venue, bookingDate: new Date('2026-12-20'), purpose: 'Birthday', expectedGuests: 40,
            status: 'cancelled', cancellationReason: 'cancelled_by_guest', totalAmount: 5000, paymentStatus: 'paid', payment: bookingPay,
            paymentSchedule: { type: 'full', depositAmount: 5000, balanceAmount: 0, balanceStatus: 'not_applicable' },
        });
        await insert('refunds', { payment: bookingPay, user: guest, reason: 'booking_cancelled', reasonDetails: 'Guest cancelled', amount: 2500, status: 'pending', requestedAt: new Date() });

        // Two tickets on one payment, for an event that was cancelled.
        const event = await insert('events', { name: 'Jazz Night', organizer, status: 'cancelled', startDateTime: new Date('2026-12-24') });
        const ticketPay = await insert('payments', { user: guest, type: 'ticket', referenceModel: 'Event', referenceId: event, amount: 998, totalAmount: 998, status: 'success' });
        await insert('tickets', { ticketId: 'T-1', user: guest, event, ticketType: 'VIP', quantity: 1, price: 499, status: 'cancelled', payment: ticketPay });
        await insert('tickets', { ticketId: 'T-2', user: guest, event, ticketType: 'VIP', quantity: 1, price: 499, status: 'cancelled', payment: ticketPay });
        await insert('refunds', { payment: ticketPay, user: guest, reason: 'event_cancelled', amount: 998, status: 'completed', reviewedBy: admin, reviewedAt: new Date(), requestedAt: new Date() });

        const { refunds } = await refundService.getAllRefunds({ limit: 10 });
        expect(refunds).toHaveLength(2);
        const byReason = Object.fromEntries(refunds.map((r: any) => [r.reason, r]));

        const b = byReason.booking_cancelled;
        expect(b.user.phone).toBe('9876543210');
        expect(b.context.booking).toMatchObject({
            charge: 'first payment', status: 'cancelled', cancellationReason: 'cancelled_by_guest', purpose: 'Birthday', expectedGuests: 40,
        });
        expect(b.context.booking.venue).toMatchObject({ name: 'Lotus Hall', city: 'Pune' });
        expect(b.context.customerRefunds).toEqual({ total: 2, refunded: 1 });

        const t = byReason.event_cancelled;
        expect(t.context.tickets.map((x: any) => x.ticketId).sort()).toEqual(['T-1', 'T-2']);
        expect(t.context.event).toMatchObject({ name: 'Jazz Night', status: 'cancelled' });
        expect(t.context.event.organizer.name).toBe('Neon Events');
        expect(t.reviewedBy.name).toBe('Ravi Admin');
        expect(t.reviewedBy.password).toBeUndefined();
    });

    it('an empty page stays empty', async () => {
        const res = await refundService.getAllRefunds({ status: 'pending' });
        expect(res.refunds).toEqual([]);
        expect(res.total).toBe(0);
    });
});
