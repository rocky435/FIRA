/**
 * Owner details on the admin's venue and creator pages.
 *
 * - Venue page: the owner's government-ID status, because the venue cannot be
 *   approved until it is verified. Bank details stay (admin-only payout read).
 * - Creator page: whether the owner carries a verified badge. Bank details and
 *   the password must not come along.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import './setup';

const adminService = require('../services/adminService');

const db = () => mongoose.connection.db!;
const oid = () => new mongoose.Types.ObjectId();

async function insertUser(extra: Record<string, unknown> = {}) {
    const _id = oid();
    await db().collection('users').insertOne({
        _id, name: 'Owner', email: `${Math.random().toString(36).slice(2)}@x.test`,
        password: 'hash', role: 'user', roles: ['user'],
        bankDetails: { accountNumber: '1234567890', ifscCode: 'HDFC0000001' },
        ...extra,
    });
    return _id;
}

describe('admin detail pages — owner fields', () => {
    it('venue page carries the owner ID status and bank details, not the password', async () => {
        const owner = await insertUser({ govIdStatus: 'rejected' });
        const venueId = oid();
        await db().collection('venues').insertOne({
            _id: venueId, name: 'Hall', owner, status: 'pending', address: { city: 'Pune' },
            createdAt: new Date(), updatedAt: new Date(),
        });

        const venue = await adminService.getVenueById(String(venueId));
        expect(venue.owner.govIdStatus).toBe('rejected');
        expect(venue.owner.bankDetails.accountNumber).toBe('1234567890');
        expect(venue.owner.password).toBeUndefined();
    });

    it('creator page carries whether the owner is verified, not bank details or password', async () => {
        const user = await insertUser({ isVerified: true, verificationBadge: 'dj' });
        const brandId = oid();
        await db().collection('brandprofiles').insertOne({
            _id: brandId, user, name: 'Bassline', type: 'dj', status: 'approved',
            createdAt: new Date(), updatedAt: new Date(),
        });

        const brand = await adminService.getBrandById(String(brandId));
        expect(brand.user.isVerified).toBe(true);
        expect(brand.user.verificationBadge).toBe('dj');
        expect(brand.user.bankDetails).toBeUndefined();
        expect(brand.user.password).toBeUndefined();
    });
});
