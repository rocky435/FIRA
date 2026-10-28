/**
 * Every refund waits for an admin ("Refunds to be done").
 *
 * Cancellations raise a pending Refund and move no money. Refunds are paid
 * manually; an admin then marks one refunded with its reference - once, even if
 * clicked twice. Nothing here calls the payment gateway. Booking cancellation
 * used to compute a refund and never raise it, and left the venue date blocked.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.REDIS_HOST;

// Count gateway refunds instead of calling Razorpay.
const gatewayRefunds: Array<{ payId: string; amount: number }> = [];
const rzpPath = require.resolve('razorpay');
require.cache[rzpPath] = {
    id: rzpPath, filename: rzpPath, loaded: true,
    exports: class {
        payments = {
            refund: async (payId: string, o: any) => {
                await new Promise(r => setTimeout(r, 20));
                gatewayRefunds.push({ payId, amount: o.amount });
                return { id: `rfnd_${gatewayRefunds.length}`, status: 'processed' };
            },
        };
    },
} as any;

const Payment = require('../models/Payment');
const Refund = require('../models/Refund');
const Booking = require('../models/Booking');
const Venue = require('../models/Venue');
const refundService = require('../services/refundService');

let app: express.Express;
let guest: string, owner: string, admin: string, moderator: string;
const tokens: Record<string, string> = {};
const bearer = (id: string) => `Bearer ${tokens[id]}`;

async function makeUser(name: string, roles = ['user'], extra: Record<string, any> = {}) {
    const _id = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('users').insertOne({
        _id, name, email: `${name}@x.test`, password: 'hash', role: roles[0], roles, ...extra,
    });
    const id = _id.toString();
    tokens[id] = jwt.sign({ userId: id, role: roles[0] }, process.env.JWT_SECRET!);
    return id;
}

const paidPayment = (user: string, amount: number, extra: Record<string, any> = {}) => Payment.create({
    user, type: 'ticket', referenceModel: 'Event', referenceId: new mongoose.Types.ObjectId(),
    amount, subtotal: amount, totalAmount: amount, status: 'success', gatewayTransactionId: `pay_${amount}`, ...extra,
});

beforeEach(async () => {
    gatewayRefunds.length = 0;
    process.env.RAZORPAY_KEY_ID = 'rzp_test';
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    guest = await makeUser('guest');
    owner = await makeUser('owner', ['venue_owner']);
    admin = await makeUser('admin', ['admin'], { adminRole: 'admin' });
    moderator = await makeUser('mod', ['admin'], { adminRole: 'moderator' });

    app = express();
    app.use(express.json());
    for (const [p, m] of [['payments', '../routes/payment'], ['bookings', '../routes/booking']]) {
        const r = await import(m);
        app.use(`/${p}`, (r as any).default || r);
    }
});

describe('raising a refund', () => {
    it('creates a pending request and moves no money', async () => {
        const pay = await paidPayment(guest, 500);
        const refund = await refundService.processRefund(pay._id, { amount: 500, reason: 'user_request', userId: guest });
        expect(refund.status).toBe('pending');
        expect(gatewayRefunds).toHaveLength(0);
        expect((await Payment.findById(pay._id).lean()).status).toBe('success');
    });
});

describe('POST /payments/refunds/:id/process', () => {
    it('marking refunded records the manual payment once, even when clicked twice, and calls no gateway', async () => {
        const pay = await paidPayment(guest, 500);
        const refund = await refundService.processRefund(pay._id, { amount: 500, reason: 'user_request', userId: guest });
        const clicks = await Promise.all([1, 2].map(() =>
            request(app).post(`/payments/refunds/${refund._id}/process`).set('Authorization', bearer(admin))
                .send({ action: 'approve', reference: 'rfnd_MANUAL123' })));
        expect(clicks.filter(r => r.status === 200)).toHaveLength(1);
        expect(gatewayRefunds).toHaveLength(0);
        const stored = await Refund.findById(refund._id).lean();
        expect(stored.status).toBe('completed');
        expect(stored.gatewayRefundId).toBe('rfnd_MANUAL123');
        expect(String(stored.reviewedBy)).toBe(admin);
        expect((await Payment.findById(pay._id).lean()).status).toBe('refunded');
    });

    it('rejection needs a reason and sends nothing', async () => {
        const pay = await paidPayment(guest, 500);
        const refund = await refundService.processRefund(pay._id, { amount: 500, reason: 'user_request', userId: guest });
        const noReason = await request(app).post(`/payments/refunds/${refund._id}/process`).set('Authorization', bearer(admin)).send({ action: 'reject' });
        expect(noReason.status).toBe(400);
        const ok = await request(app).post(`/payments/refunds/${refund._id}/process`).set('Authorization', bearer(admin))
            .send({ action: 'reject', notes: 'Ticket already used' });
        expect(ok.status).toBe(200);
        const stored = await Refund.findById(refund._id).lean();
        expect(stored.status).toBe('rejected');
        expect(stored.rejectionReason).toBe('Ticket already used');
        expect(gatewayRefunds).toHaveLength(0);
    });

    it('is not available to moderators or customers', async () => {
        const pay = await paidPayment(guest, 500);
        const refund = await refundService.processRefund(pay._id, { amount: 500, reason: 'user_request', userId: guest });
        for (const who of [moderator, guest]) {
            const res = await request(app).post(`/payments/refunds/${refund._id}/process`).set('Authorization', bearer(who)).send({ action: 'approve' });
            expect(res.status).toBe(403);
        }
        expect(gatewayRefunds).toHaveLength(0);
        expect((await Refund.findById(refund._id).lean()).status).toBe('pending');
    });

    it('an action other than approve or reject is refused', async () => {
        const pay = await paidPayment(guest, 500);
        const refund = await refundService.processRefund(pay._id, { amount: 500, reason: 'user_request', userId: guest });
        const res = await request(app).post(`/payments/refunds/${refund._id}/process`).set('Authorization', bearer(admin)).send({ action: 'pay-twice' });
        expect(res.status).toBe(400);
        expect((await Refund.findById(refund._id).lean()).status).toBe('pending');
    });
});

describe('guest cancels a paid booking', () => {
    it('raises pending refunds per the venue policy for what was paid, and frees the date', async () => {
        const date = new Date(Date.now() + 30 * 86400000);
        const day = date.toISOString().slice(0, 10);
        const venue = await Venue.create({
            owner, name: 'Hall', description: 'd', capacity: { min: 1, max: 100 }, pricing: { basePrice: 10000 },
            address: { street: 's', city: 'Hyderabad', state: 'TS', pincode: '500001' }, status: 'approved',
        });
        const deposit = await paidPayment(guest, 1059, { type: 'venue_booking', referenceModel: 'Booking', subtotal: 1000 });
        const balance = await paidPayment(guest, 9531, { type: 'venue_booking', referenceModel: 'Booking', subtotal: 9000 });
        const booking = await Booking.create({
            user: guest, venue: venue._id, bookingDate: date, startTime: '18:00', endTime: '23:00', totalAmount: 10000,
            status: 'accepted', paymentStatus: 'paid', payment: deposit._id,
            paymentSchedule: { type: 'installment', depositAmount: 1000, balanceAmount: 9000, balanceStatus: 'paid', balancePayment: balance._id },
        });
        await Venue.updateOne({ _id: venue._id }, { $set: { blockedDates: [{ date: day, slots: [{ startTime: '18:00', endTime: '23:00', type: 'booked', booking: booking._id }] }] } });

        const res = await request(app).post(`/bookings/${booking._id}/cancel`).set('Authorization', bearer(guest)).send({});
        expect(res.status).toBe(200);
        // 30 days out is inside the default full-refund window.
        expect(res.body.refundPercentage).toBe(100);
        expect(res.body.refundAmount).toBe(10000);
        expect(res.body.refundStatus).toBe('pending_approval');

        const refunds = await Refund.find({}).lean();
        expect(refunds.map((r: any) => r.amount).sort((a: number, b: number) => a - b)).toEqual([1000, 9000]);
        expect(refunds.every((r: any) => r.status === 'pending')).toBe(true);
        expect(gatewayRefunds).toHaveLength(0);

        expect((await Booking.findById(booking._id).lean()).status).toBe('cancelled');
        expect((await Venue.findById(venue._id).lean()).blockedDates).toEqual([]);

        const again = await request(app).post(`/bookings/${booking._id}/cancel`).set('Authorization', bearer(guest)).send({});
        expect(again.status).toBe(400);
        expect(await Refund.countDocuments()).toBe(2);
    });

    it('refunds nothing on a booking that was never paid', async () => {
        const venue = await Venue.create({
            owner, name: 'Hall', description: 'd', capacity: { min: 1, max: 100 }, pricing: { basePrice: 10000 },
            address: { street: 's', city: 'Hyderabad', state: 'TS', pincode: '500001' }, status: 'approved',
        });
        const booking = await Booking.create({
            user: guest, venue: venue._id, bookingDate: new Date(Date.now() + 30 * 86400000), startTime: '18:00', endTime: '23:00',
            totalAmount: 10000, status: 'pending', paymentSchedule: { type: 'installment', depositAmount: 1000, balanceAmount: 9000, balanceStatus: 'pending' },
        });
        const res = await request(app).post(`/bookings/${booking._id}/cancel`).set('Authorization', bearer(guest)).send({});
        expect(res.status).toBe(200);
        expect(res.body.amountPaid).toBe(0);
        expect(res.body.refundAmount).toBe(0);
        expect(await Refund.countDocuments()).toBe(0);
    });
});
