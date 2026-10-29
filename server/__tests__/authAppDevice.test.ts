/**
 * The mobile app sends its device with sign-in: `player_id` (the device's FCM
 * token) and `device_type`. Login saves it into the user's device list - the
 * same list POST /notifications/fcm/register fills, so several devices work -
 * and logout with the same `player_id` clears just that phone.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.REDIS_HOST;

const bcrypt = require('bcryptjs');
const authRoutes = require('../routes/auth');
const DeviceToken = require('../models/DeviceToken');

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);

const phone = `fcm-phone-${'p'.repeat(40)}`;
const tablet = `fcm-tablet-${'t'.repeat(40)}`;
let userId: mongoose.Types.ObjectId;

beforeEach(async () => {
    userId = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('users').insertOne({
        _id: userId, name: 'Asha', email: 'asha@x.test', password: await bcrypt.hash('Secret123!', 4),
        role: 'user', roles: ['user'], emailVerified: true,
    });
});

const login = (extra: object = {}) =>
    request(app).post('/auth/login').send({ email: 'asha@x.test', password: 'Secret123!', ...extra });

describe('app device at login and logout', () => {
    it('login saves player_id and device_type as an app device; a second device is kept too', async () => {
        const res = await login({ player_id: phone, device_type: 'iOS' });
        expect(res.status).toBe(200);
        expect(res.body.token).toBeTruthy();
        expect(res.body.deviceSaved).toBe(true);
        await login({ player_id: tablet, device_type: 'android' });

        const devices = await DeviceToken.find({ user: userId }).lean();
        expect(devices.map((d: any) => [d.token, d.platform]).sort()).toEqual([[phone, 'ios'], [tablet, 'android']].sort());
    });

    it('a missing or bad player_id never stops the login', async () => {
        expect((await login()).body.deviceSaved).toBe(false);
        const bad = await login({ player_id: 'short', device_type: 'android' });
        expect(bad.status).toBe(200);
        expect(bad.body.deviceSaved).toBe(false);
        expect(await DeviceToken.countDocuments({ user: userId })).toBe(0);
    });

    it('logout with player_id clears only that phone; logout without it (the website) clears nothing', async () => {
        const { body } = await login({ player_id: phone, device_type: 'ios' });
        await login({ player_id: tablet, device_type: 'android' });

        // Logout's status depends on the Redis session blocklist (absent here, so
        // 503); the device is cleared before that step either way.
        await request(app).post('/auth/logout').set('Authorization', `Bearer ${body.token}`).send({});
        expect(await DeviceToken.countDocuments({ user: userId })).toBe(2);

        const { body: again } = await login();
        await request(app).post('/auth/logout').set('Authorization', `Bearer ${again.token}`).send({ player_id: phone });
        const left = await DeviceToken.find({ user: userId }).lean();
        expect(left.map((d: any) => d.token)).toEqual([tablet]);
    });
});
