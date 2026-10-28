/**
 * Payment integrity.
 *
 * - verifyPayment checked the Razorpay signature without tying the signed order
 *   to the payment record, so a signature from a ₹1 order marked any payment
 *   (a ₹50,000 booking) as paid - and anyone could mark a stranger's payment failed.
 * - /payments/initiate took the charge amount from the client.
 * - /payments/:id/refund let anyone refund anyone's payment, for any amount.
 * - /payments/:id and /payments/refunds/:id were readable by any signed-in user.
 * - Booking verify picked "any pending payment" on the booking, so a stale
 *   10% advance order could be paid and used to mark the 90% balance paid.
 * - Ticket redemption matched the subtotal but not what was actually charged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.RAZORPAY_KEY_SECRET = 'rzp-test-secret';
delete process.env.REDIS_HOST;

const Payment = require('../models/Payment');
const Booking = require('../models/Booking');
const Event = require('../models/Event');
const Ticket = require('../models/Ticket');
const bookingService = require('../services/bookingService');
const ticketService = require('../services/ticketService');

let app: express.Express;
let buyer: string, stranger: string, admin: string;
const tokens: Record<string, string> = {};

async function makeUser(name: string, role = 'user') {
    const _id = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('users').insertOne({
        _id, name, email: `${name}@x.test`, password: 'hash', role, roles: [role],
    });
    const id = _id.toString();
    tokens[id] = jwt.sign({ userId: id, role }, process.env.JWT_SECRET!);
    return id;
}

const bearer = (id: string) => `Bearer ${tokens[id]}`;
const sign = (orderId: string, paymentId: string) =>
    crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!).update(`${orderId}|${paymentId}`).digest('hex');

/** A payment as initiatePayment leaves it: pending, with its own gateway order. */
async function pendingPayment(user: string, orderId: string, overrides: Record<string, any> = {}) {
    return Payment.create({
        user, type: 'ticket', referenceId: new mongoose.Types.ObjectId(), referenceModel: 'Event',
        amount: 50000, subtotal: 50000, totalAmount: 50000, status: 'pending', gatewayOrderId: orderId,
        ...overrides,
    });
}

beforeEach(async () => {
    buyer = await makeUser('buyer');
    stranger = await makeUser('stranger');
    admin = await makeUser('admin', 'admin');

    app = express();
    app.use(express.json());
    const routes = await import('../routes/payment');
    app.use('/payments', (routes as any).default || routes);
});

describe('POST /payments/verify', () => {
    it("refuses a valid signature from a different (cheap) order", async () => {
        await pendingPayment(buyer, 'order_cheap', { amount: 1, subtotal: 1, totalAmount: 1 });
        const big = await pendingPayment(buyer, 'order_big');
        const res = await request(app).post('/payments/verify').set('Authorization', bearer(buyer)).send({
            paymentId: big._id, gatewayOrderId: 'order_cheap', gatewayPaymentId: 'pay_1',
            gatewaySignature: sign('order_cheap', 'pay_1'),
        });
        expect(res.status).toBe(400);
        expect((await Payment.findById(big._id).lean()).status).toBe('pending');
    });

    it("won't let a stranger touch someone else's payment - not even to fail it", async () => {
        const p = await pendingPayment(buyer, 'order_a');
        const res = await request(app).post('/payments/verify').set('Authorization', bearer(stranger)).send({
            paymentId: p._id, gatewayOrderId: 'order_a', gatewayPaymentId: 'pay_x', gatewaySignature: 'bad',
        });
        expect(res.status).toBe(400);
        expect((await Payment.findById(p._id).lean()).status).toBe('pending');
    });

    it('confirms a genuine payment, and treats a repeat of the same verify as success', async () => {
        const p = await pendingPayment(buyer, 'order_a');
        const body = { paymentId: p._id, gatewayOrderId: 'order_a', gatewayPaymentId: 'pay_1', gatewaySignature: sign('order_a', 'pay_1') };
        const first = await request(app).post('/payments/verify').set('Authorization', bearer(buyer)).send(body);
        expect(first.status).toBe(200);
        expect(first.body.success).toBe(true);
        const stored = await Payment.findById(p._id).lean();
        expect(stored.status).toBe('success');
        expect(stored.gatewayTransactionId).toBe('pay_1');

        const again = await request(app).post('/payments/verify').set('Authorization', bearer(buyer)).send(body);
        expect(again.status).toBe(200);
    });

    it('a bad signature fails a pending payment but never undoes a successful one', async () => {
        const p = await pendingPayment(buyer, 'order_a', { status: 'success', gatewayTransactionId: 'pay_1' });
        const res = await request(app).post('/payments/verify').set('Authorization', bearer(buyer)).send({
            paymentId: p._id, gatewayOrderId: 'order_a', gatewayPaymentId: 'pay_2', gatewaySignature: 'bad',
        });
        expect(res.status).toBe(400);
        expect((await Payment.findById(p._id).lean()).status).toBe('success');
    });
});

describe('admin-only payment routes', () => {
    it('POST /payments/initiate is admin-only', async () => {
        const res = await request(app).post('/payments/initiate').set('Authorization', bearer(buyer))
            .send({ type: 'ticket', referenceId: new mongoose.Types.ObjectId(), referenceModel: 'Event', totalAmount: 1 });
        expect(res.status).toBe(403);
        expect(await Payment.countDocuments()).toBe(0);
    });

    it('POST /payments/:id/refund is admin-only', async () => {
        const p = await pendingPayment(buyer, 'order_a', { status: 'success', gatewayTransactionId: 'pay_1' });
        for (const who of [buyer, stranger]) {
            const res = await request(app).post(`/payments/${p._id}/refund`).set('Authorization', bearer(who))
                .send({ reason: 'user_request', amount: 50000 });
            expect(res.status).toBe(403);
        }
        expect((await Payment.findById(p._id).lean()).status).toBe('success');
    });
});

describe('reading payments and refunds', () => {
    it('GET /payments/:id is for the payer and admins only', async () => {
        const p = await pendingPayment(buyer, 'order_a');
        expect((await request(app).get(`/payments/${p._id}`).set('Authorization', bearer(stranger))).status).toBe(404);
        expect((await request(app).get(`/payments/${p._id}`).set('Authorization', bearer(buyer))).status).toBe(200);
        expect((await request(app).get(`/payments/${p._id}`).set('Authorization', bearer(admin))).status).toBe(200);
    });

    it('GET /payments/refunds/:id is for the refund owner and admins only', async () => {
        const p = await pendingPayment(buyer, 'order_a');
        const refund = await mongoose.model('Refund').create({ payment: p._id, user: buyer, reason: 'user_request', amount: 10 });
        expect((await request(app).get(`/payments/refunds/${refund._id}`).set('Authorization', bearer(stranger))).status).toBe(404);
        expect((await request(app).get(`/payments/refunds/${refund._id}`).set('Authorization', bearer(buyer))).status).toBe(200);
    });

    it('GET /payments/refunds reaches the refunds list instead of being read as a payment id', async () => {
        const res = await request(app).get('/payments/refunds').set('Authorization', bearer(admin));
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('refunds');
    });
});

describe('booking payment verification', () => {
    async function installmentBooking() {
        return Booking.create({
            user: buyer, venue: new mongoose.Types.ObjectId(),
            bookingDate: new Date(Date.now() + 30 * 86400000), startTime: '10:00', endTime: '14:00',
            totalAmount: 100000, status: 'accepted', paymentStatus: 'paid',
            paymentSchedule: { type: 'installment', depositAmount: 10000, balanceAmount: 90000, balanceStatus: 'pending',
                balanceDueAt: new Date(Date.now() + 20 * 86400000) },
        });
    }
    const bookingPayment = (bookingId: any, orderId: string, subtotal: number) => Payment.create({
        user: buyer, type: 'venue_booking', referenceId: bookingId, referenceModel: 'Booking',
        amount: subtotal, subtotal, totalAmount: subtotal, status: 'pending', gatewayOrderId: orderId,
    });

    it('a paid stale advance order cannot be used to mark the balance paid', async () => {
        const b = await installmentBooking();
        await bookingPayment(b._id, 'order_stale_advance', 10000);
        await expect(bookingService.completeBalancePayment(b._id, {
            gatewayOrderId: 'order_stale_advance', gatewayPaymentId: 'pay_1', gatewaySignature: sign('order_stale_advance', 'pay_1'),
        })).rejects.toThrow('not for the booking balance');
        expect((await Booking.findById(b._id).lean()).paymentSchedule.balanceStatus).toBe('pending');
    });

    it('verifies the balance against the order that was actually paid', async () => {
        const b = await installmentBooking();
        await bookingPayment(b._id, 'order_old_balance', 90000);
        const real = await bookingPayment(b._id, 'order_new_balance', 90000);
        const result = await bookingService.completeBalancePayment(b._id, {
            gatewayOrderId: 'order_new_balance', gatewayPaymentId: 'pay_9', gatewaySignature: sign('order_new_balance', 'pay_9'),
        });
        expect(result.success).toBe(true);
        expect(String((await Booking.findById(b._id).lean()).paymentSchedule.balancePayment)).toBe(String(real._id));
        expect((await Payment.findById(real._id).lean()).status).toBe('success');
    });

    it("an order from a different payment can't confirm a booking", async () => {
        const b = await installmentBooking();
        await Booking.updateOne({ _id: b._id }, { $set: { paymentStatus: 'pending', status: 'pending' } });
        await bookingPayment(b._id, 'order_advance', 10000);
        await pendingPayment(buyer, 'order_cheap', { amount: 1, subtotal: 1, totalAmount: 1 });
        await expect(bookingService.completeBookingPayment(b._id, {
            gatewayOrderId: 'order_cheap', gatewayPaymentId: 'pay_1', gatewaySignature: sign('order_cheap', 'pay_1'),
        })).rejects.toThrow('Payment record not found');
        expect((await Booking.findById(b._id).lean()).paymentStatus).toBe('pending');
    });
});

describe('ticket redemption checks what was actually charged', () => {
    async function paidEventSetup() {
        const ev = await Event.create({
            organizer: new mongoose.Types.ObjectId(), name: 'Paid', description: 'd', maxAttendees: 100,
            ticketPrice: 999, status: 'approved',
            startDateTime: new Date(Date.now() + 7 * 86400000), endDateTime: new Date(Date.now() + 7.2 * 86400000),
        });
        return ev;
    }
    const successPayment = (eventId: any, overrides: Record<string, any>) => Payment.create({
        user: buyer, type: 'ticket', referenceId: eventId, referenceModel: 'Event', status: 'success',
        subtotal: 999, metadata: { quantity: 1, ticketType: 'general' }, ...overrides,
    });

    it('refuses a payment whose subtotal says ₹999 but which only charged ₹1', async () => {
        const ev = await paidEventSetup();
        const p = await successPayment(ev._id, { amount: 1, totalAmount: 1 });
        await expect(ticketService.purchaseTicket({ userId: buyer, eventId: ev._id, quantity: 1, paymentId: p._id }))
            .rejects.toThrow('could not be verified');
        expect(await Ticket.countDocuments()).toBe(0);
    });

    it('refuses a payment that invents a discount', async () => {
        const ev = await paidEventSetup();
        const p = await successPayment(ev._id, { amount: 1, totalAmount: 1, discountAmount: 1057.81, discountCode: 'FAKE' });
        await expect(ticketService.purchaseTicket({ userId: buyer, eventId: ev._id, quantity: 1, paymentId: p._id }))
            .rejects.toThrow('could not be verified');
    });

    it('accepts a payment that charged the full bill', async () => {
        const ev = await paidEventSetup();
        // 999 + 5% fee (49.95) + 18% GST on the fee (8.99) = 1057.94
        const p = await successPayment(ev._id, { amount: 1057.94, totalAmount: 1057.94 });
        const result = await ticketService.purchaseTicket({ userId: buyer, eventId: ev._id, quantity: 1, paymentId: p._id });
        expect(result.ticket || result).toBeTruthy();
        expect(await Ticket.countDocuments()).toBe(1);
    });
});
