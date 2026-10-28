/**
 * Discount codes and notifications belong to someone.
 *
 * GET /discounts/events/:id/discount-codes listed an event's codes to any
 * signed-in user, and notifications could be read, marked read or deleted by
 * anyone holding the id.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.REDIS_HOST;

const Event = require('../models/Event');
const DiscountCode = require('../models/DiscountCode');
const Notification = require('../models/Notification');

let app: express.Express;
let owner: string, stranger: string, admin: string;
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

beforeEach(async () => {
    owner = await makeUser('owner');
    stranger = await makeUser('stranger');
    admin = await makeUser('admin', 'admin');

    app = express();
    app.use(express.json());
    const discounts = await import('../routes/discount');
    app.use('/discounts', (discounts as any).default || discounts);
    const notifications = await import('../routes/notification');
    app.use('/notifications', (notifications as any).default || notifications);
});

describe('GET /discounts/events/:id/discount-codes', () => {
    it("is the organizer's (and admins') only", async () => {
        const ev = await Event.create({
            organizer: owner, name: 'E', description: 'd', maxAttendees: 10,
            startDateTime: new Date(Date.now() + 86400000), endDateTime: new Date(Date.now() + 90000000),
        });
        await DiscountCode.collection.insertOne({ event: ev._id, code: 'SECRET50', discountType: 'percentage', discountValue: 50 });
        const path = `/discounts/events/${ev._id}/discount-codes`;

        const asStranger = await request(app).get(path).set('Authorization', bearer(stranger));
        expect(asStranger.status).toBe(403);
        expect(JSON.stringify(asStranger.body)).not.toContain('SECRET50');

        const asOwner = await request(app).get(path).set('Authorization', bearer(owner));
        expect(asOwner.status).toBe(200);
        expect(asOwner.body[0].code).toBe('SECRET50');

        expect((await request(app).get(path).set('Authorization', bearer(admin))).status).toBe(200);
    });
});

describe('notifications by id', () => {
    it("can't be read, marked or deleted by another user", async () => {
        const n = await Notification.create({ user: owner, type: 'system', title: 'Private', message: 'm' });

        expect((await request(app).get(`/notifications/${n._id}`).set('Authorization', bearer(stranger))).status).toBe(404);
        expect((await request(app).put(`/notifications/${n._id}/read`).set('Authorization', bearer(stranger))).status).toBe(400);
        await request(app).delete(`/notifications/${n._id}`).set('Authorization', bearer(stranger));
        const stored = await Notification.findById(n._id).lean();
        expect(stored).not.toBeNull();
        expect(stored.isRead).toBe(false);
    });

    it('work for their owner', async () => {
        const n = await Notification.create({ user: owner, type: 'system', title: 'Mine', message: 'm' });
        expect((await request(app).get(`/notifications/${n._id}`).set('Authorization', bearer(owner))).status).toBe(200);
        expect((await request(app).put(`/notifications/${n._id}/read`).set('Authorization', bearer(owner))).status).toBe(200);
        expect((await Notification.findById(n._id).lean()).isRead).toBe(true);
        expect((await request(app).delete(`/notifications/${n._id}`).set('Authorization', bearer(owner))).status).toBe(200);
        expect(await Notification.findById(n._id)).toBeNull();
    });
});
