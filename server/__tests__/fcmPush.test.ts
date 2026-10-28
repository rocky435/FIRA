/**
 * Native app push (FCM), alongside browser Web Push.
 *
 * Token registration is per signed-in user, deduplicated on the token, keeps
 * one row per device across token refreshes, and can only remove your own
 * token. Sending goes to every device of the user, prunes tokens FCM reports
 * as dead, and fires for both notifications and chat - while Web Push is
 * still called for the same events. Firebase itself is replaced by a fake
 * messaging client; no credentials are needed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.REDIS_HOST;
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const DeviceToken = require('../models/DeviceToken');
const fcmService = require('../services/fcmService');
const pushService = require('../services/pushService');
const notificationService = require('../services/notificationService');

let app: express.Express;
let alice: string, bob: string;
const tokens: Record<string, string> = {};

const fcmToken = (n: string | number) => `fcm-token-${n}-${'x'.repeat(40)}`;

async function makeUser(name: string) {
    const _id = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('users').insertOne({
        _id, name, email: `${name}${Date.now()}@x.test`, password: 'hash', role: 'user', roles: ['user'],
        emailVerified: true,
    });
    const id = _id.toString();
    tokens[id] = jwt.sign({ userId: id, role: 'user' }, process.env.JWT_SECRET!);
    return id;
}

const bearer = (id: string) => `Bearer ${tokens[id]}`;
const register = (user: string, body: object) =>
    request(app).post('/notifications/fcm/register').set('Authorization', bearer(user)).send(body);

/** A fake FCM client: every token succeeds unless listed in `dead` / `broken`. */
function fakeMessaging({ dead = [] as string[], broken = [] as string[] } = {}) {
    return {
        sendEachForMulticast: vi.fn(async (msg: any) => ({
            // Like firebase-admin: tokens first, then fids.
            responses: [...(msg.tokens || []), ...(msg.fids || [])].map((t: string) => {
                if (dead.includes(t)) return { success: false, error: { code: 'messaging/registration-token-not-registered', message: 'gone' } };
                if (broken.includes(t)) return { success: false, error: { code: 'messaging/internal-error', message: 'try later' } };
                return { success: true };
            }),
        })),
    };
}

beforeEach(async () => {
    alice = await makeUser('alice');
    bob = await makeUser('bob');
    app = express();
    app.use(express.json());
    const notifications = await import('../routes/notification');
    const messages = await import('../routes/message');
    app.use('/notifications', (notifications as any).default || notifications);
    app.use('/messages', (messages as any).default || messages);
});

afterEach(() => {
    fcmService._setMessagingForTests(null);
    vi.restoreAllMocks();
});

describe('POST /notifications/fcm/register', () => {
    it('requires sign-in', async () => {
        const res = await request(app).post('/notifications/fcm/register').send({ token: fcmToken(1) });
        expect(res.status).toBe(401);
        expect(await DeviceToken.countDocuments()).toBe(0);
    });

    it('stores the token once, however often it is registered', async () => {
        expect((await register(alice, { token: fcmToken(1), platform: 'android', appVersion: '1.0.0' })).status).toBe(201);
        expect((await register(alice, { token: fcmToken(1), platform: 'android' })).status).toBe(201);
        const rows = await DeviceToken.find({}).lean();
        expect(rows).toHaveLength(1);
        expect(rows[0].user.toString()).toBe(alice);
        expect(rows[0].platform).toBe('android');
    });

    it('keeps one row per device for every device a user has', async () => {
        await register(alice, { token: fcmToken('phone') });
        await register(alice, { token: fcmToken('tablet') });
        expect(await DeviceToken.countDocuments({ user: alice })).toBe(2);
    });

    it('moves a token to whoever signs in on that device', async () => {
        await register(alice, { token: fcmToken(1) });
        await register(bob, { token: fcmToken(1) });
        const rows = await DeviceToken.find({}).lean();
        expect(rows).toHaveLength(1);
        expect(rows[0].user.toString()).toBe(bob);
    });

    it('replaces the old token on refresh (previousToken or same deviceId)', async () => {
        await register(alice, { token: fcmToken('old'), deviceId: 'pixel-1' });
        await register(alice, { token: fcmToken('new'), deviceId: 'pixel-1' });
        expect((await DeviceToken.find({ user: alice }).lean()).map((d: any) => d.token)).toEqual([fcmToken('new')]);

        await register(alice, { token: fcmToken('newer'), previousToken: fcmToken('new') });
        expect((await DeviceToken.find({ user: alice }).lean()).map((d: any) => d.token)).toEqual([fcmToken('newer')]);
    });

    it("cannot remove someone else's token through previousToken", async () => {
        await register(bob, { token: fcmToken('bob') });
        await register(alice, { token: fcmToken('alice'), previousToken: fcmToken('bob') });
        expect(await DeviceToken.countDocuments({ token: fcmToken('bob') })).toBe(1);
    });

    it('keeps at most 10 devices per user, dropping the least recently used', async () => {
        for (let i = 0; i < 12; i++) await register(alice, { token: fcmToken(`d${i}`) });
        const left = (await DeviceToken.find({ user: alice }).lean()).map((d: any) => d.token);
        expect(left).toHaveLength(10);
        expect(left).not.toContain(fcmToken('d0'));
        expect(left).toContain(fcmToken('d11'));
    });

    it('accepts a Firebase Installation ID (fid) from the newer app API', async () => {
        const fid = 'cXk2Rz1hVf0aB3dE5fG7hJ';
        expect((await register(alice, { fid, platform: 'android' })).status).toBe(201);
        const row: any = await DeviceToken.findOne({ user: alice }).lean();
        expect(row).toMatchObject({ token: fid, kind: 'fid' });

        const res = await request(app).post('/notifications/fcm/unregister')
            .set('Authorization', bearer(alice)).send({ fid });
        expect(res.body.removed).toBe(1);
    });

    it('rejects a missing or malformed token and an unknown platform', async () => {
        expect((await register(alice, {})).status).toBe(400);
        expect((await register(alice, { token: 'short' })).status).toBe(400);
        expect((await register(alice, { token: { $gt: '' } })).status).toBe(400);
        expect((await register(alice, { token: fcmToken(1), platform: 'windows' })).status).toBe(400);
        expect(await DeviceToken.countDocuments()).toBe(0);
    });
});

describe('POST /notifications/fcm/unregister', () => {
    it('removes your own token on logout', async () => {
        await register(alice, { token: fcmToken(1) });
        const res = await request(app).post('/notifications/fcm/unregister')
            .set('Authorization', bearer(alice)).send({ token: fcmToken(1) });
        expect(res.status).toBe(200);
        expect(res.body.removed).toBe(1);
        expect(await DeviceToken.countDocuments()).toBe(0);
    });

    it("cannot remove another user's token", async () => {
        await register(alice, { token: fcmToken(1) });
        const res = await request(app).post('/notifications/fcm/unregister')
            .set('Authorization', bearer(bob)).send({ token: fcmToken(1) });
        expect(res.body.removed).toBe(0);
        expect(await DeviceToken.countDocuments()).toBe(1);
    });
});

describe('sending', () => {
    it('is a safe no-op without Firebase credentials, and the test endpoint says so', async () => {
        await register(alice, { token: fcmToken(1) });
        expect(await fcmService.sendToUser(alice, { title: 'Hi' })).toMatchObject({ sent: 0, skipped: true });
        const res = await request(app).post('/notifications/fcm/test').set('Authorization', bearer(alice));
        expect(res.status).toBe(503);
    });

    it('sends title, body and string data to every device of the user', async () => {
        const fake = fakeMessaging();
        fcmService._setMessagingForTests(fake);
        await register(alice, { token: fcmToken('a') });
        await register(alice, { token: fcmToken('b') });
        await register(bob, { token: fcmToken('bob') });

        const result = await fcmService.sendToUser(alice, {
            title: 'Booking accepted', body: 'Pay to confirm', url: '/dashboard/bookings/1',
            data: { type: 'booking_update', referenceId: new mongoose.Types.ObjectId(), count: 2 },
        });
        expect(result).toMatchObject({ sent: 2, failed: 0 });

        const msg = fake.sendEachForMulticast.mock.calls[0][0];
        expect(msg.tokens.sort()).toEqual([fcmToken('a'), fcmToken('b')].sort());
        expect(msg.notification).toEqual({ title: 'Booking accepted', body: 'Pay to confirm' });
        expect(msg.data.link).toBe('/dashboard/bookings/1');
        expect(msg.data.type).toBe('booking_update');
        expect(Object.values(msg.data).every(v => typeof v === 'string')).toBe(true);
        expect(msg.android.notification.channelId).toBe('fira_default');
    });

    it('deletes tokens FCM reports as dead and keeps ones that failed for a passing reason', async () => {
        fcmService._setMessagingForTests(fakeMessaging({ dead: [fcmToken('dead')], broken: [fcmToken('flaky')] }));
        await register(alice, { token: fcmToken('ok') });
        await register(alice, { token: fcmToken('dead') });
        await register(alice, { token: fcmToken('flaky') });
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const result = await fcmService.sendToUser(alice, { title: 'Hi' });
        expect(result).toMatchObject({ sent: 1, failed: 1, expired: 1 });
        const left = (await DeviceToken.find({ user: alice }).lean()).map((d: any) => d.token).sort();
        expect(left).toEqual([fcmToken('flaky'), fcmToken('ok')].sort());
    });

    it('sends tokens and fids in one batch and prunes a dead fid', async () => {
        const deadFid = 'deadFidAAAAAAAAAAAAAAAA';
        const fake = fakeMessaging({ dead: [deadFid] });
        fcmService._setMessagingForTests(fake);
        await register(alice, { token: fcmToken('classic') });
        await register(alice, { fid: 'liveFidBBBBBBBBBBBBBBBB' });
        await register(alice, { fid: deadFid });

        const result = await fcmService.sendToUser(alice, { title: 'Hi' });
        expect(result).toMatchObject({ sent: 2, failed: 0, expired: 1 });
        const msg = fake.sendEachForMulticast.mock.calls[0][0];
        expect(msg.tokens).toEqual([fcmToken('classic')]);
        expect(msg.fids.sort()).toEqual(['liveFidBBBBBBBBBBBBBBBB', deadFid].sort());
        expect(await DeviceToken.countDocuments({ token: deadFid })).toBe(0);
    });

    it('never throws when Firebase itself fails', async () => {
        fcmService._setMessagingForTests({ sendEachForMulticast: vi.fn().mockRejectedValue(new Error('network down')) });
        await register(alice, { token: fcmToken(1) });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(fcmService.sendToUser(alice, { title: 'Hi' })).resolves.toMatchObject({ sent: 0 });
    });

    it('the test endpoint delivers to your devices', async () => {
        fcmService._setMessagingForTests(fakeMessaging());
        await register(alice, { token: fcmToken(1) });
        const res = await request(app).post('/notifications/fcm/test').set('Authorization', bearer(alice));
        expect(res.status).toBe(200);
        expect(res.body.sent).toBe(1);
    });
});

describe('notification triggers reach the app and still reach browsers', () => {
    it('a push-channel notification goes out on FCM and Web Push', async () => {
        const fake = fakeMessaging();
        fcmService._setMessagingForTests(fake);
        const webPush = vi.spyOn(pushService, 'sendToUsers');
        await register(alice, { token: fcmToken(1) });

        await notificationService.createNotification({
            userId: alice, type: 'booking_accepted', title: 'Booking accepted', message: 'Pay to confirm',
            data: { referenceId: new mongoose.Types.ObjectId(), actionUrl: '/dashboard/bookings/1' }, channel: 'all',
        });

        await vi.waitFor(() => expect(fake.sendEachForMulticast).toHaveBeenCalledTimes(1));
        expect(webPush).toHaveBeenCalledTimes(1);
        const msg = fake.sendEachForMulticast.mock.calls[0][0];
        expect(msg.data).toMatchObject({ type: 'booking_accepted', link: '/dashboard/bookings/1' });
    });

    it('an in-app-only notification sends no push', async () => {
        const fake = fakeMessaging();
        fcmService._setMessagingForTests(fake);
        await register(alice, { token: fcmToken(1) });
        await notificationService.createNotification({
            userId: alice, type: 'system', title: 'Quiet', message: 'inbox only', channel: 'in_app',
        });
        await new Promise(r => setTimeout(r, 50));
        expect(fake.sendEachForMulticast).not.toHaveBeenCalled();
    });

    it('a chat message reaches the recipient app, not the sender', async () => {
        const fake = fakeMessaging();
        fcmService._setMessagingForTests(fake);
        const webPush = vi.spyOn(pushService, 'sendToUsers');
        await register(alice, { token: fcmToken('alice') });
        await register(bob, { token: fcmToken('bob') });

        const res = await request(app).post('/messages/send')
            .set('Authorization', bearer(alice)).send({ receiverId: bob, content: 'Is the hall free on Saturday?' });
        expect(res.status).toBe(201);

        await vi.waitFor(() => expect(fake.sendEachForMulticast).toHaveBeenCalledTimes(1));
        const msg = fake.sendEachForMulticast.mock.calls[0][0];
        expect(msg.tokens).toEqual([fcmToken('bob')]);
        expect(msg.data).toMatchObject({ type: 'message', conversationId: res.body.conversationId.toString() });
        expect(msg.notification.body).toBe('Is the hall free on Saturday?');
        expect(webPush).toHaveBeenCalledTimes(1);
    });
});
