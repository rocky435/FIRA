/**
 * Access control on the user profile routes.
 *
 * PUT /users/:id passed the whole request body into $set, so any user could
 * send {"roles":["admin"]} and become an admin. GET /users/:id had no auth and
 * returned the whole document - bank accounts, government ID - to anyone, and
 * GET /users listed every account's private data to any signed-in user.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import './setup';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.REDIS_HOST;

const User = require('../models/User');

let app: express.Express;
let alice: string, bob: string, admin: string;
const tokens: Record<string, string> = {};

const PRIVATE = {
    phone: '9999999999',
    businessPhone: '8888888888',
    govIdType: 'pan',
    govIdNumber: 'ABCDE1234F',
    govIdDocument: 'https://example.test/id.png',
    bankDetails: { accountName: 'Alice', accountNumber: '123456789012', ifscCode: 'HDFC0001234', bankName: 'HDFC' },
};

async function makeUser(name: string, role = 'user') {
    const _id = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('users').insertOne({
        _id, name, email: `${name}@x.test`, password: 'hash', role, roles: [role],
        isVerified: false, emailVerified: true, ...PRIVATE,
    });
    const id = _id.toString();
    tokens[id] = jwt.sign({ userId: id, role }, process.env.JWT_SECRET!);
    return id;
}

const bearer = (id: string) => `Bearer ${tokens[id]}`;

beforeEach(async () => {
    alice = await makeUser('alice');
    bob = await makeUser('bob');
    admin = await makeUser('admin', 'admin');

    app = express();
    app.use(express.json());
    const routes = await import('../routes/user');
    app.use('/users', (routes as any).default || routes);
});

describe('PUT /users/:id', () => {
    it('ignores role, verification and block fields - no self-promotion to admin', async () => {
        const res = await request(app)
            .put(`/users/${alice}`)
            .set('Authorization', bearer(alice))
            .send({
                name: 'Alice Renamed',
                role: 'admin', roles: ['admin'], adminRole: 'super_admin',
                isVerified: true, emailVerified: false, verificationBadge: 'gold',
                isBlocked: false, govIdVerified: true,
                bankDetails: { accountNumber: '000000000' }, email: 'evil@x.test', password: 'x',
            });
        expect(res.status).toBe(200);

        const stored = await User.findById(alice).lean();
        expect(stored.name).toBe('Alice Renamed');
        expect(stored.role).toBe('user');
        expect(stored.roles).toEqual(['user']);
        expect(stored.adminRole ?? null).toBeNull();
        expect(stored.isVerified).toBe(false);
        expect(stored.emailVerified).toBe(true);
        expect(stored.email).toBe('alice@x.test');
        expect(stored.password).toBe('hash');
        expect(stored.bankDetails.accountNumber).toBe('123456789012');
    });

    it("still refuses to edit someone else's profile", async () => {
        const res = await request(app)
            .put(`/users/${bob}`)
            .set('Authorization', bearer(alice))
            .send({ name: 'pwned' });
        expect(res.status).toBe(403);
        expect((await User.findById(bob).lean()).name).toBe('bob');
    });
});

describe('GET /users/:id', () => {
    const assertPublicOnly = (body: any) => {
        expect(body.name).toBe('alice');
        for (const field of ['email', 'phone', 'businessPhone', 'govIdNumber', 'govIdDocument',
            'govIdType', 'bankDetails', 'bankAccounts', 'password', 'isBlocked', 'adminRole']) {
            expect(body).not.toHaveProperty(field);
        }
    };

    it('returns only the public profile to an anonymous caller', async () => {
        const res = await request(app).get(`/users/${alice}`);
        expect(res.status).toBe(200);
        assertPublicOnly(res.body);
    });

    it('returns only the public profile to another signed-in user', async () => {
        const res = await request(app).get(`/users/${alice}`).set('Authorization', bearer(bob));
        expect(res.status).toBe(200);
        assertPublicOnly(res.body);
    });

    it('returns the full profile (bank details included) to its owner', async () => {
        const res = await request(app).get(`/users/${alice}`).set('Authorization', bearer(alice));
        expect(res.status).toBe(200);
        expect(res.body.email).toBe('alice@x.test');
        expect(res.body.bankDetails.accountNumber).toBe('123456789012');
        expect(res.body).not.toHaveProperty('password');
    });

    it('returns the full profile to an admin', async () => {
        const res = await request(app).get(`/users/${alice}`).set('Authorization', bearer(admin));
        expect(res.status).toBe(200);
        expect(res.body.govIdNumber).toBe('ABCDE1234F');
    });

    it('treats an invalid token as anonymous rather than failing', async () => {
        const res = await request(app).get(`/users/${alice}`).set('Authorization', 'Bearer garbage');
        expect(res.status).toBe(200);
        assertPublicOnly(res.body);
    });
});

describe('GET /users', () => {
    it('refuses a non-admin', async () => {
        const res = await request(app).get('/users').set('Authorization', bearer(alice));
        expect(res.status).toBe(403);
    });

    it('allows an admin', async () => {
        const res = await request(app).get('/users').set('Authorization', bearer(admin));
        expect(res.status).toBe(200);
        expect(res.body.users.length).toBe(3);
    });
});
