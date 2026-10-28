/**
 * A limited discount code is used up by sales, not by checkouts.
 *
 * The code was redeemed when checkout opened, before any payment, and never
 * given back - so opening checkout 50 times without paying exhausted a
 * "first 50 buyers" code. A paid order now counts when its payment is
 * confirmed; an order the code makes free counts (atomically) when issued.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import crypto from 'crypto';
import './setup';

process.env.RAZORPAY_KEY_SECRET = 'rzp-test-secret';

const Event = require('../models/Event');
const DiscountCode = require('../models/DiscountCode');
const Payment = require('../models/Payment');
const Ticket = require('../models/Ticket');
const ticketService = require('../services/ticketService');
const paymentService = require('../services/paymentService');

let buyer: mongoose.Types.ObjectId;
let eventId: mongoose.Types.ObjectId;

async function makeCode(overrides: Record<string, any> = {}) {
    return DiscountCode.create({
        event: eventId, code: 'FIRST50', discountType: 'percentage', discountValue: 10, maxUses: 1,
        validFrom: new Date(Date.now() - 86400000), validUntil: new Date(Date.now() + 86400000),
        createdBy: new mongoose.Types.ObjectId(), ...overrides,
    });
}

beforeEach(async () => {
    buyer = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('users').insertOne({ _id: buyer, name: 'b', email: 'b@x.test' });
    const ev = await Event.create({
        organizer: new mongoose.Types.ObjectId(), name: 'Paid', description: 'd', maxAttendees: 100,
        ticketPrice: 500, status: 'approved',
        startDateTime: new Date(Date.now() + 7 * 86400000), endDateTime: new Date(Date.now() + 7.2 * 86400000),
    });
    eventId = ev._id;
});

describe('discount redemption', () => {
    it('opening checkout does not use up the code', async () => {
        const code = await makeCode();
        const saved = { id: process.env.RAZORPAY_KEY_ID, secret: process.env.RAZORPAY_KEY_SECRET };
        delete process.env.RAZORPAY_KEY_ID; // checkout stops at order creation, after discount pricing
        try {
            for (let i = 0; i < 3; i++) {
                await expect(ticketService.purchaseTicket({ userId: buyer, eventId, quantity: 1, discountCode: 'first50' }))
                    .rejects.toThrow('Razorpay credentials not configured');
            }
        } finally {
            if (saved.id) process.env.RAZORPAY_KEY_ID = saved.id;
            process.env.RAZORPAY_KEY_SECRET = saved.secret;
        }
        expect((await DiscountCode.findById(code._id).lean()).usedCount).toBe(0);
    });

    it('a confirmed payment counts once, however many times it is verified', async () => {
        const code = await makeCode({ maxUses: 5 });
        const p = await Payment.create({
            user: buyer, type: 'ticket', referenceId: eventId, referenceModel: 'Event', status: 'pending',
            amount: 476.55, subtotal: 500, totalAmount: 476.55, discountCode: 'FIRST50', discountAmount: 52.95,
            gatewayOrderId: 'order_1',
        });
        const signature = crypto.createHmac('sha256', 'rzp-test-secret').update('order_1|pay_1').digest('hex');
        const verify = () => paymentService.verifyPayment({
            paymentId: p._id, gatewayOrderId: 'order_1', gatewayPaymentId: 'pay_1', gatewaySignature: signature,
        });
        await Promise.all([verify(), verify(), verify()]);
        await verify();
        expect((await DiscountCode.findById(code._id).lean()).usedCount).toBe(1);
    });

    it('a code never takes off the platform fee and GST', async () => {
        // Flat ₹10,000 off covers the ₹500 ticket, not the ₹25 fee and ₹4.50 GST.
        await makeCode({ discountType: 'flat', discountValue: 10000, maxUses: 5 });
        const bill = paymentService.calculateBilling(500, 1, 5, 10000);
        expect(bill).toMatchObject({ discountAmount: 500, platformFee: 25, gstAmount: 4.5, totalAmount: 29.5 });
    });

    it('a code that makes the order free is redeemed at issue, and only within its limit', async () => {
        // Only possible at a 0% platform fee: then ₹10,000 off makes the ₹500 ticket free.
        await Event.updateOne({ _id: eventId }, { $set: { platformFeePercentage: 0 } });
        const code = await makeCode({ discountType: 'flat', discountValue: 10000, maxUses: 1 });
        const attempts = await Promise.all(Array.from({ length: 4 }, () =>
            ticketService.purchaseTicket({ userId: buyer, eventId, quantity: 1, discountCode: 'FIRST50' })
                .then(() => 'ok', (e: Error) => e.message)));
        expect(attempts.filter(r => r === 'ok').length).toBe(1);
        expect(await Ticket.countDocuments()).toBe(1);
        expect((await DiscountCode.findById(code._id).lean()).usedCount).toBe(1);
    });
});
