/**
 * Razorpay webhook.
 *
 * If the app is killed between paying and calling /verify (common on mobile,
 * where UPI hands off to another app), the money was taken but no ticket was
 * issued. The webhook confirms the payment server-to-server and completes the
 * order - idempotently with the app's own verify/redeem calls.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import crypto from 'crypto';
import './setup';

process.env.RAZORPAY_KEY_SECRET = 'rzp-test-secret';
const WEBHOOK_SECRET = 'whsec-test';

const Payment = require('../models/Payment');
const Event = require('../models/Event');
const Ticket = require('../models/Ticket');
const Booking = require('../models/Booking');
const paymentService = require('../services/paymentService');
const ticketService = require('../services/ticketService');
const bookingService = require('../services/bookingService');

let app: express.Express;
let buyer: mongoose.Types.ObjectId;

const webhookBody = (orderId: string, paymentId: string, amountPaise: number, event = 'payment.captured') =>
    JSON.stringify({ event, payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: amountPaise, status: 'captured' } } } });
const hmac = (secret: string, body: string) => crypto.createHmac('sha256', secret).update(body).digest('hex');
const deliver = (body: string, signature = hmac(WEBHOOK_SECRET, body)) =>
    request(app).post('/payments/webhook').set('Content-Type', 'application/json').set('X-Razorpay-Signature', signature).send(body);

async function ticketCheckout(orderId: string) {
    const ev = await Event.create({
        organizer: new mongoose.Types.ObjectId(), name: 'Gig', description: 'd', maxAttendees: 100,
        ticketPrice: 500, status: 'approved',
        startDateTime: new Date(Date.now() + 7 * 86400000), endDateTime: new Date(Date.now() + 7.2 * 86400000),
    });
    // As requirePaymentFor leaves it: ₹500 + 5% fee + 18% GST on the fee = ₹529.50.
    const payment = await Payment.create({
        user: buyer, type: 'ticket', referenceId: ev._id, referenceModel: 'Event', status: 'pending',
        amount: 529.5, subtotal: 500, totalAmount: 529.5, platformFeePercentage: 5,
        metadata: { quantity: 1, ticketType: 'general' }, gatewayOrderId: orderId,
    });
    return { ev, payment };
}

beforeEach(async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    buyer = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('users').insertOne({ _id: buyer, name: 'b', email: 'b@x.test' });

    // Same raw-body capture as index.js.
    app = express();
    app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
    const routes = await import('../routes/payment');
    app.use('/payments', (routes as any).default || routes);
});

describe('POST /payments/webhook', () => {
    it('rejects a delivery with a bad signature', async () => {
        const { payment } = await ticketCheckout('order_1');
        const res = await deliver(webhookBody('order_1', 'pay_1', 52950), 'forged');
        expect(res.status).toBe(400);
        expect((await Payment.findById(payment._id).lean()).status).toBe('pending');
        expect(await Ticket.countDocuments()).toBe(0);
    });

    it('is disabled until a webhook secret is configured', async () => {
        delete process.env.RAZORPAY_WEBHOOK_SECRET;
        const res = await deliver(webhookBody('order_1', 'pay_1', 52950));
        expect(res.status).toBe(503);
    });

    it('completes a ticket order the app never came back for - once, however often it is delivered', async () => {
        const { payment } = await ticketCheckout('order_1');
        const body = webhookBody('order_1', 'pay_1', 52950);
        expect((await deliver(body)).status).toBe(200);
        expect((await deliver(body)).status).toBe(200);
        await deliver(webhookBody('order_1', 'pay_1', 52950, 'order.paid'));

        expect((await Payment.findById(payment._id).lean()).status).toBe('success');
        const tickets = await Ticket.find({ payment: payment._id }).lean();
        expect(tickets.length).toBe(1);
        expect(String(tickets[0].user)).toBe(String(buyer));
    });

    it("leaves the app's own verify and redeem working after the webhook got there first", async () => {
        const { ev, payment } = await ticketCheckout('order_1');
        await deliver(webhookBody('order_1', 'pay_1', 52950));

        const verified = await paymentService.verifyPayment({
            paymentId: payment._id, gatewayOrderId: 'order_1', gatewayPaymentId: 'pay_1',
            gatewaySignature: hmac('rzp-test-secret', 'order_1|pay_1'),
        }, { actorId: buyer });
        expect(verified.success).toBe(true);

        const redeemed = await ticketService.purchaseTicket({ userId: buyer, eventId: ev._id, quantity: 1, paymentId: payment._id });
        expect(redeemed.success).toBe(true);
        expect(await Ticket.countDocuments()).toBe(1);
        expect((await Event.findById(ev._id).lean()).currentAttendees).toBe(1);
    });

    it('ignores a delivery whose amount does not match the order', async () => {
        const { payment } = await ticketCheckout('order_1');
        const res = await deliver(webhookBody('order_1', 'pay_1', 100));
        expect(res.status).toBe(200);
        expect((await Payment.findById(payment._id).lean()).status).toBe('pending');
        expect(await Ticket.countDocuments()).toBe(0);
    });

    it('ignores unknown orders and unrelated events', async () => {
        expect((await deliver(webhookBody('order_unknown', 'pay_1', 100))).status).toBe(200);
        expect((await deliver(JSON.stringify({ event: 'refund.created', payload: {} }))).status).toBe(200);
    });

    it("records a booking advance when the guest's app never verified it (request then waits for the owner), and a late verify still succeeds", async () => {
        const booking = await Booking.create({
            user: buyer, venue: new mongoose.Types.ObjectId(), status: 'pending',
            bookingDate: new Date(Date.now() + 30 * 86400000), startTime: '10:00', endTime: '14:00',
            totalAmount: 20000, paymentSchedule: { type: 'full' },
        });
        await Payment.create({
            user: buyer, type: 'venue_booking', referenceId: booking._id, referenceModel: 'Booking', status: 'pending',
            amount: 21180, subtotal: 20000, totalAmount: 21180, gatewayOrderId: 'order_b',
        });

        expect((await deliver(webhookBody('order_b', 'pay_b', 2118000))).status).toBe(200);
        const paid = await Booking.findById(booking._id).lean();
        expect(paid.paymentStatus).toBe('paid');
        // Paid, not accepted: the venue owner decides next.
        expect(paid.status).toBe('pending');

        const late = await bookingService.completeBookingPayment(booking._id, {
            gatewayOrderId: 'order_b', gatewayPaymentId: 'pay_b', gatewaySignature: hmac('rzp-test-secret', 'order_b|pay_b'),
        });
        expect(late.success).toBe(true);
    });
});
