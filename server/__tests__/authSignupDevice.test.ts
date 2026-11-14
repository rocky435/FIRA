/**
 * Signup takes the app's FCM token as `player_id` (FCM requirements: Signup and
 * Login both accept it). It is held on the unverified account and linked as a
 * device only when the email code is entered - before that, the email is not
 * proven, and linking would let someone signing up with another person's email
 * receive that person's notifications once they verify.
 *
 * Kept to 5 signups: the signup rate limit (5/hour per address) is shared by
 * every request in this file.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.REDIS_HOST;

const emailService = require('../services/emailService');
const authRoutes = require('../routes/auth');
const DeviceToken = require('../models/DeviceToken');
const OTP = require('../models/OTP');
const User = require('../models/User');

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);

const tok = (n: string) => `fcm-${n}-${'x'.repeat(40)}`;
const PASSWORD = 'Secret123!';

beforeEach(() => {
    vi.spyOn(emailService, 'sendOTPEmail').mockResolvedValue(true);
    vi.spyOn(emailService, 'sendWelcomeEmail').mockResolvedValue(true);
});

const signup = (email: string, extra: object = {}, path = '/auth/register') =>
    request(app).post(path).send({ name: 'Asha Rao', email, password: PASSWORD, ...extra });

async function verify(email: string, extra: object = {}) {
    const otp = await OTP.findOne({ email, type: 'email_verification' }).lean();
    return request(app).post('/auth/verify-otp').send({ email, code: otp.code, ...extra });
}

describe('player_id at signup', () => {
    it('is held until the email is verified, then becomes a device', async () => {
        const email = 'one@x.test';
        const res = await signup(email, { player_id: tok('signup'), device_type: 'ios', device_id: 'install-1', app_version: '2.3.0' });
        expect(res.status).toBe(201);
        // Response unchanged: no token, nothing about the device.
        expect(res.body).toEqual({ success: true, message: expect.any(String), email });

        const user = await User.findOne({ email }).lean();
        expect(await DeviceToken.countDocuments({ user: user._id })).toBe(0);

        const verified = await verify(email);
        expect(verified.status).toBe(200);
        expect(verified.body.token).toBeTruthy();
        expect(verified.body.deviceSaved).toBe(true);
        expect(verified.body.signupDevice).toBeUndefined();

        const devices = await DeviceToken.find({ user: user._id }).lean();
        expect(devices).toHaveLength(1);
        expect(devices[0]).toMatchObject({ token: tok('signup'), platform: 'ios', deviceId: 'install-1', appVersion: '2.3.0' });
        // The held copy is cleared once used.
        expect((await User.findById(user._id).select('+signupDevice').lean()).signupDevice).toBeNull();
    });

    it('a player_id sent with the code wins over the one from signup', async () => {
        const email = 'two@x.test';
        await signup(email, { player_id: tok('old-phone'), device_type: 'android' });
        const res = await verify(email, { player_id: tok('new-phone'), device_type: 'ios' });
        expect(res.body.deviceSaved).toBe(true);

        const user = await User.findOne({ email }).lean();
        const devices = await DeviceToken.find({ user: user._id }).lean();
        expect(devices.map((d: any) => d.token)).toEqual([tok('new-phone')]);
    });

    it('a bad player_id never fails signup, and signing up again replaces the held token', async () => {
        const email = 'three@x.test';
        const bad = await signup(email, { player_id: 'short', device_type: 'android' });
        expect(bad.status).toBe(201);
        expect((await User.findOne({ email }).select('+signupDevice').lean()).signupDevice).toBeNull();

        await signup(email, { player_id: tok('second-try'), device_type: 'android' });
        const res = await verify(email);
        expect(res.status).toBe(200);
        const user = await User.findOne({ email }).lean();
        expect((await DeviceToken.find({ user: user._id }).lean()).map((d: any) => d.token)).toEqual([tok('second-try')]);
    });

    it('venue-owner signup takes player_id the same way', async () => {
        const email = 'owner@x.test';
        const res = await signup(email, { player_id: tok('owner'), device_type: 'android', businessName: 'Lotus Hall' }, '/auth/register-venue-owner');
        expect(res.status).toBe(201);
        const user = await User.findOne({ email }).lean();
        expect(await DeviceToken.countDocuments({ user: user._id })).toBe(0);

        expect((await verify(email)).body.deviceSaved).toBe(true);
        expect(await DeviceToken.countDocuments({ user: user._id, token: tok('owner') })).toBe(1);
    });
});
