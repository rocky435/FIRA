/**
 * Routes that were fully public and now need the right caller:
 *   - verification: anyone could list applicants' ID documents or approve
 *     their own badge
 *   - upload: anyone could host files on our Cloudinary or delete any image
 *   - whatsapp send-test / send-template: anyone could message from our
 *     business number
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
const VerificationRequest = require('../models/VerificationRequest');

// Stub the SDK so nothing reaches Cloudinary; record what would be deleted.
const cloudinary = require('cloudinary').v2;
const destroyed: string[] = [];
cloudinary.uploader.destroy = async (id: string) => { destroyed.push(id); return { result: 'ok' }; };

let app: express.Express;
let applicant: string, stranger: string, admin: string;
const tokens: Record<string, string> = {};

async function makeUser(name: string, role = 'user') {
    const _id = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('users').insertOne({
        _id, name, email: `${name}@x.test`, password: 'hash', role, roles: [role], isVerified: false,
    });
    const id = _id.toString();
    tokens[id] = jwt.sign({ userId: id, role }, process.env.JWT_SECRET!);
    return id;
}

const bearer = (id: string) => `Bearer ${tokens[id]}`;

beforeEach(async () => {
    destroyed.length = 0;
    applicant = await makeUser('applicant');
    stranger = await makeUser('stranger');
    admin = await makeUser('admin', 'admin');

    app = express();
    app.use(express.json());
    for (const [path, mod] of [['verification', '../routes/verification'], ['upload', '../routes/upload'], ['whatsapp', '../routes/whatsapp']]) {
        const routes = await import(mod);
        app.use(`/${path}`, (routes as any).default || routes);
    }
});

describe('verification', () => {
    const submit = (who: string, body: Record<string, any> = {}) =>
        request(app).post('/verification').set('Authorization', bearer(who))
            .send({ type: 'brand', name: 'Brand', description: 'd', ...body });

    it('listing is admin-only', async () => {
        expect((await request(app).get('/verification')).status).toBe(401);
        expect((await request(app).get('/verification').set('Authorization', bearer(stranger))).status).toBe(403);
        expect((await request(app).get('/verification').set('Authorization', bearer(admin))).status).toBe(200);
    });

    it('a submission is always for the caller and always starts pending', async () => {
        const res = await submit(applicant, { user: stranger, status: 'approved', reviewedBy: admin });
        expect(res.status).toBe(201);
        const stored = await VerificationRequest.findById(res.body._id).lean();
        expect(String(stored.user)).toBe(applicant);
        expect(stored.status).toBe('pending');
        expect(stored.reviewedBy).toBeNull();
    });

    it("an applicant cannot read or edit someone else's request", async () => {
        const { body } = await submit(applicant);
        expect((await request(app).get(`/verification/${body._id}`).set('Authorization', bearer(stranger))).status).toBe(403);
        expect((await request(app).put(`/verification/${body._id}`).set('Authorization', bearer(stranger)).send({ name: 'x' })).status).toBe(403);
        expect((await request(app).get(`/verification/user/${applicant}`).set('Authorization', bearer(stranger))).status).toBe(403);
        expect((await request(app).get(`/verification/${body._id}`).set('Authorization', bearer(applicant))).status).toBe(200);
    });

    it('an applicant cannot approve their own request or set status by editing it', async () => {
        const { body } = await submit(applicant);
        const self = await request(app).put(`/verification/${body._id}/review`)
            .set('Authorization', bearer(applicant)).send({ status: 'approved' });
        expect(self.status).toBe(403);
        await request(app).put(`/verification/${body._id}`).set('Authorization', bearer(applicant)).send({ status: 'approved' });
        expect((await VerificationRequest.findById(body._id).lean()).status).toBe('pending');
        expect((await User.findById(applicant).lean()).isVerified).toBe(false);
    });

    it('an admin approval verifies the user and records the admin as reviewer', async () => {
        const { body } = await submit(applicant);
        const res = await request(app).put(`/verification/${body._id}/review`)
            .set('Authorization', bearer(admin)).send({ status: 'approved', reviewedBy: stranger });
        expect(res.status).toBe(200);
        const stored = await VerificationRequest.findById(body._id).lean();
        expect(String(stored.reviewedBy)).toBe(admin);
        expect((await User.findById(applicant).lean()).isVerified).toBe(true);
    });
});

describe('upload', () => {
    it('uploading needs a session', async () => {
        const res = await request(app).post('/upload/single').attach('image', Buffer.from('x'), 'a.png');
        expect(res.status).toBe(401);
    });

    it('deleting needs a session', async () => {
        const res = await request(app).delete('/upload/delete').send({ publicId: 'fira/venues/abc' });
        expect(res.status).toBe(401);
        expect(destroyed).toEqual([]);
    });

    it("refuses to delete an image that isn't on the caller's listing", async () => {
        await mongoose.connection.db!.collection('venues').insertOne({
            owner: new mongoose.Types.ObjectId(applicant), name: 'V',
            images: ['https://res.cloudinary.com/x/image/upload/v1/fira/venues/abc.jpg'],
        });
        const res = await request(app).delete('/upload/delete').set('Authorization', bearer(stranger))
            .send({ publicId: 'fira/venues/abc' });
        expect(res.status).toBe(403);
        expect(destroyed).toEqual([]);
    });

    it("deletes an image on the caller's own venue, as the venue page sends it", async () => {
        await mongoose.connection.db!.collection('venues').insertOne({
            owner: new mongoose.Types.ObjectId(applicant), name: 'V',
            images: ['https://res.cloudinary.com/x/image/upload/v1/fira/venues/abc.jpg'],
        });
        // Older venue pages send "<folder>/<file>", without the fira/ prefix.
        // The image is stored as "fira/venues/abc", so that is what gets deleted
        // (deleting "venues/abc" silently removed nothing).
        const res = await request(app).delete('/upload/delete').set('Authorization', bearer(applicant))
            .send({ publicId: 'venues/abc' });
        expect(res.status).toBe(200);
        expect(destroyed).toEqual(['fira/venues/abc']);
    });

    it('lets an admin delete any image', async () => {
        const res = await request(app).delete('/upload/delete').set('Authorization', bearer(admin))
            .send({ publicId: 'fira/general/zzz' });
        expect(res.status).toBe(200);
        expect(destroyed).toEqual(['fira/general/zzz']);
    });
});

describe('whatsapp send endpoints', () => {
    it('are admin-only', async () => {
        for (const path of ['/whatsapp/send-test', '/whatsapp/send-template']) {
            expect((await request(app).post(path).send({ to: '919999999999' })).status).toBe(401);
            expect((await request(app).post(path).set('Authorization', bearer(stranger)).send({ to: '919999999999' })).status).toBe(403);
        }
    });
});
