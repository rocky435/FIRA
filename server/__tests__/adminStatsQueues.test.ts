/**
 * The admin dashboard's "needs attention" counts.
 *
 * pendingRefunds counts refunds raised but not yet paid; pendingIdChecks counts
 * the people in the ID review queue, using the same filter the queue itself lists
 * with - so the badge on the nav and the length of the ID Checks page agree.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import './setup';

const adminService = require('../services/adminService');
const identityService = require('../services/identityService');

const db = () => mongoose.connection.db!;
const oid = () => new mongoose.Types.ObjectId();

async function insertUser(extra: Record<string, unknown> = {}) {
    await db().collection('users').insertOne({
        _id: oid(), name: 'U', email: `${Math.random().toString(36).slice(2)}@x.test`,
        password: 'hash', role: 'user', roles: ['user'], ...extra,
    });
}

async function insertRefund(status: string) {
    await db().collection('refunds').insertOne({
        _id: oid(), payment: oid(), user: oid(), amount: 100, reason: 'other', status,
        createdAt: new Date(), updatedAt: new Date(),
    });
}

describe('getStats — admin work queues', () => {
    it('counts only refunds still waiting to be paid', async () => {
        await insertRefund('pending');
        await insertRefund('pending');
        await insertRefund('completed');
        await insertRefund('rejected');

        const stats = await adminService.getStats();
        expect(stats.pendingRefunds).toBe(2);
    });

    it('counts the ID review queue exactly as the queue lists it', async () => {
        await insertUser({ govIdStatus: 'pending' });
        await insertUser({ panStatus: 'pending' });
        await insertUser({ govIdStatus: 'pending', panStatus: 'pending' }); // one person, two checks
        await insertUser({ govIdNumber: 'X123', govIdStatus: 'none' });       // legacy: document, no status
        await insertUser({ govIdStatus: 'verified', panStatus: 'rejected' }); // nothing waiting
        await insertUser();                                                    // never submitted

        const stats = await adminService.getStats();
        const queue = await identityService.listPending();
        expect(stats.pendingIdChecks).toBe(4);
        expect(stats.pendingIdChecks).toBe(queue.length);
    });

    it('reports zero for both on an empty platform', async () => {
        const stats = await adminService.getStats();
        expect(stats.pendingRefunds).toBe(0);
        expect(stats.pendingIdChecks).toBe(0);
    });
});
