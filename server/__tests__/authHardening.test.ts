/**
 * Session and OTP hardening.
 *
 * - Blocking a user did nothing: isBlocked was never checked at login or per request.
 * - Changing or resetting a password left every existing session working.
 * - The reset token worked any number of times for its 15 minutes.
 * - OTPs were 4 digits from Math.random, and the 5-guess limit was read-then-save,
 *   so parallel requests got around it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.REDIS_HOST;

const User = require('../models/User');
const OTP = require('../models/OTP');
const authService = require('../services/authService');

let app: express.Express;
const PASSWORD = 'OldPassw0rd!';

async function makeUser(overrides: Record<string, any> = {}) {
    return User.create({
        name: 'Alice', email: `alice_${Math.random().toString(36).slice(2)}@x.test`,
        password: await bcrypt.hash(PASSWORD, 4), emailVerified: true, ...overrides,
    });
}

beforeEach(async () => {
    app = express();
    app.use(express.json());
    const routes = await import('../routes/auth');
    app.use('/auth', (routes as any).default || routes);
});

describe('blocked accounts', () => {
    it('cannot log in, and an existing session stops working', async () => {
        const user = await makeUser();
        const { token } = await authService.login({ email: user.email, password: PASSWORD });
        expect((await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);

        await User.updateOne({ _id: user._id }, { $set: { isBlocked: true } });

        await expect(authService.login({ email: user.email, password: PASSWORD })).rejects.toThrow('suspended');
        const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
        expect(me.status).toBe(401);
        expect(me.body.error).toContain('suspended');
    });
});

describe('password change and reset sign out other sessions', () => {
    it('change: old tokens die, the returned token works', async () => {
        const user = await makeUser();
        const { token: other } = await authService.login({ email: user.email, password: PASSWORD });

        const res = await request(app).post('/auth/change-password').set('Authorization', `Bearer ${other}`)
            .send({ currentPassword: PASSWORD, newPassword: 'NewPassw0rd!' });
        expect(res.status).toBe(200);
        expect(res.body.token).toBeTruthy();

        expect((await request(app).get('/auth/me').set('Authorization', `Bearer ${other}`)).status).toBe(401);
        expect((await request(app).get('/auth/me').set('Authorization', `Bearer ${res.body.token}`)).status).toBe(200);
    });

    it('a stolen token can no longer be refreshed after the owner changes their password', async () => {
        const user = await makeUser();
        const { token: stolen } = await authService.login({ email: user.email, password: PASSWORD });
        await authService.changePassword({ userId: user._id, currentPassword: PASSWORD, newPassword: 'NewPassw0rd!' });
        expect((await request(app).post('/auth/refresh').set('Authorization', `Bearer ${stolen}`)).status).toBe(401);
    });

    it('tokens minted before versioning (no tv claim) keep working until a change', async () => {
        const user = await makeUser();
        const legacy = jwt.sign({ userId: user._id, role: 'user' }, process.env.JWT_SECRET!);
        expect((await request(app).get('/auth/me').set('Authorization', `Bearer ${legacy}`)).status).toBe(200);
    });

    it('reset: works once, signs out existing sessions, and the token cannot be replayed', async () => {
        const user = await makeUser();
        const { token: session } = await authService.login({ email: user.email, password: PASSWORD });
        await OTP.create({ email: user.email, code: '123456', type: 'password_reset', expiresAt: new Date(Date.now() + 600000) });

        const { resetToken } = await authService.verifyResetOTP({ email: user.email, code: '123456' });
        const first = await request(app).post('/auth/reset-password').send({ resetToken, newPassword: 'NewPassw0rd!' });
        expect(first.status).toBe(200);
        expect((await request(app).get('/auth/me').set('Authorization', `Bearer ${session}`)).status).toBe(401);

        const replay = await request(app).post('/auth/reset-password').send({ resetToken, newPassword: 'Another1Pass!' });
        expect(replay.status).toBe(400);
        await expect(authService.login({ email: user.email, password: 'NewPassw0rd!' })).resolves.toHaveProperty('token');
    });

    it('a reset token is useless without a verified code behind it', async () => {
        const user = await makeUser();
        const forged = jwt.sign({ email: user.email, purpose: 'password_reset' }, process.env.JWT_SECRET!, { expiresIn: '15m' });
        const res = await request(app).post('/auth/reset-password').send({ resetToken: forged, newPassword: 'NewPassw0rd!' });
        expect(res.status).toBe(400);
    });
});

describe('OTP codes', () => {
    it('are 4 digits, leading zeros included', () => {
        for (let i = 0; i < 500; i++) {
            expect(authService.generateOTP()).toMatch(/^\d{4}$/);
        }
    });

    it('allow at most 3 guesses even when the guesses arrive in parallel', async () => {
        const user = await makeUser();
        await OTP.create({ email: user.email, code: '6543', type: 'password_reset', expiresAt: new Date(Date.now() + 600000) });

        const guesses = Array.from({ length: 20 }, (_, i) =>
            authService.verifyResetOTP({ email: user.email, code: String(1000 + i) }).then(() => 'ok', (e: Error) => e.message));
        const results = await Promise.all(guesses);

        const counted = results.filter(r => r.startsWith('Invalid reset code')).length;
        expect(counted).toBeLessThanOrEqual(3);
        expect(results.every(r => r !== 'ok')).toBe(true);

        // Even the right code is refused once the guesses are spent.
        await expect(authService.verifyResetOTP({ email: user.email, code: '6543' })).rejects.toThrow();
    });
});
