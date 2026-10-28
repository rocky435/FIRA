/**
 * Ticket cancellation.
 *
 * - Two quick cancel requests could both pass the "is it active?" check and
 *   both refund the ticket.
 * - The refund policy read event.date, which the Event schema doesn't have, so
 *   every cancellation was treated as "under 24 hours" and refunded nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import './setup';

const Event = require('../models/Event');
const Ticket = require('../models/Ticket');
const Payment = require('../models/Payment');
const refundService = require('../services/refundService');

let holder: mongoose.Types.ObjectId;

async function setup(daysUntilEvent: number) {
    holder = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('users').insertOne({ _id: holder, name: 'h', email: 'h@x.test' });
    const ev = await Event.create({
        organizer: new mongoose.Types.ObjectId(), name: 'Gig', description: 'd', maxAttendees: 10,
        currentAttendees: 1, ticketPrice: 500, status: 'approved',
        startDateTime: new Date(Date.now() + daysUntilEvent * 86400000),
        endDateTime: new Date(Date.now() + daysUntilEvent * 86400000 + 3600000),
    });
    const payment = await Payment.create({
        user: holder, type: 'ticket', referenceId: ev._id, referenceModel: 'Event', status: 'success',
        amount: 529.5, subtotal: 500, totalAmount: 529.5, gatewayTransactionId: 'pay_1',
    });
    return Ticket.create({
        user: holder, event: ev._id, ticketId: 'TKT-1', quantity: 1, ticketType: 'general',
        price: 500, payment: payment._id, status: 'active',
    });
}

describe('initiateTicketRefund', () => {
    let refundCalls: number;
    const realProcessRefund = refundService.processRefund;

    beforeEach(() => {
        refundCalls = 0;
        refundService.processRefund = async (_paymentId: any, { amount }: any) => {
            refundCalls += 1;
            await new Promise(r => setTimeout(r, 20)); // widen the race window
            return { _id: new mongoose.Types.ObjectId(), amount };
        };
        return () => { refundService.processRefund = realProcessRefund; };
    });

    it('refunds once when cancel is sent several times at once', async () => {
        const ticket = await setup(7);
        const results = await Promise.all(Array.from({ length: 5 }, () =>
            refundService.initiateTicketRefund(ticket._id, holder).then(() => 'ok', (e: Error) => e.message)));
        expect(results.filter(r => r === 'ok').length).toBe(1);
        expect(refundCalls).toBe(1);
        expect((await Ticket.findById(ticket._id).lean()).status).toBe('cancelled');
    });

    it('applies the stated policy: a full refund 48+ hours before the event', async () => {
        const ticket = await setup(7);
        const { refundEligibility } = await refundService.initiateTicketRefund(ticket._id, holder);
        expect(refundEligibility.refundPercentage).toBe(100);
        expect(refundEligibility.amount).toBe(500);
        expect(refundCalls).toBe(1);
    });

    it('reports eligibility from the real start time', async () => {
        const ticket = await setup(7);
        const eligibility = await refundService.checkTicketRefundEligibility(ticket._id);
        expect(eligibility.eligible).toBe(true);
        expect(eligibility.refundAmount).toBe(500);
    });

    it('gives the ticket back if the refund itself fails, so the holder can retry', async () => {
        const ticket = await setup(7);
        refundService.processRefund = async () => { throw new Error('gateway down'); };
        await expect(refundService.initiateTicketRefund(ticket._id, holder)).rejects.toThrow('gateway down');
        expect((await Ticket.findById(ticket._id).lean()).status).toBe('active');
    });
});
