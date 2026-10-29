/**
 * A logged-out token must stop working - including on a server that runs Redis
 * on the default 127.0.0.1 without REDIS_HOST set, which is how production
 * runs. The blocklist check used to run only when REDIS_HOST was set, so in
 * production logout wrote the token to Redis but no request ever read it.
 *
 * cacheService is patched before the middleware loads (it destructures the
 * functions), the same approach as unit/tokenBlocklist.test.ts.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const savedHost = process.env.REDIS_HOST;
delete process.env.REDIS_HOST;

const cacheService = require('../services/cacheService');
const original = { isRedisAvailable: cacheService.isRedisAvailable, getRedisClient: cacheService.getRedisClient };
const blocked = new Set<string>();
let redisUp = true;
cacheService.isRedisAvailable = () => redisUp;
cacheService.getRedisClient = () => ({ get: async (k: string) => (blocked.has(k) ? '1' : null) });

const auth = require('../middleware/auth');

const app = express();
app.get('/me', auth, (req: any, res) => res.json({ id: String(req.user._id) }));

let token: string;
beforeEach(async () => {
    blocked.clear();
    redisUp = true;
    const _id = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('users').insertOne({ _id, name: 'A', email: `${_id}@x.test`, role: 'user', roles: ['user'] });
    token = jwt.sign({ userId: String(_id) }, process.env.JWT_SECRET as string);
});

afterAll(() => {
    Object.assign(cacheService, original);
    if (savedHost !== undefined) process.env.REDIS_HOST = savedHost;
});

const me = () => request(app).get('/me').set('Authorization', `Bearer ${token}`);

describe('logged-out tokens without REDIS_HOST', () => {
    it('a logged-out token is refused while Redis is connected', async () => {
        expect((await me()).status).toBe(200);
        blocked.add(`blocked:${token}`);
        const res = await me();
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/invalidated/);
    });

    it('with no Redis at all (development) sign-in still works', async () => {
        redisUp = false;
        expect((await me()).status).toBe(200);
    });
});
