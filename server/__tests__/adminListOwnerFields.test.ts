/**
 * Owner details the admin lists show beside each row.
 *
 * - Venues: the owner's government-ID status. A venue cannot be approved until
 *   that ID is verified, so the list says so before the admin tries.
 * - Venue Owners: the same status on each owner row, without expanding it.
 * - Creators (brands): whether the owner carries a verified badge.
 *
 * Bank details and passwords must still not leak into the venue or brand lists.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import './setup';

const adminService = require('../services/adminService');

const db = () => mongoose.connection.db!;
const oid = () => new mongoose.Types.ObjectId();

async function insertOwner(extra: Record<string, unknown> = {}) {
    const _id = oid();
    await db().collection('users').insertOne({
        _id, name: 'Owner', email: `${Math.random().toString(36).slice(2)}@x.test`,
        password: 'hash', role: 'venue_owner', roles: ['user', 'venue_owner'],
        bankDetails: { accountNumber: '1234567890', ifscCode: 'HDFC0000001' },
        ...extra,
    });
    return _id;
}

describe('admin lists — owner fields', () => {
    it('venues carry the owner ID status, but not bank details or password', async () => {
        const owner = await insertOwner({ govIdStatus: 'pending' });
        await db().collection('venues').insertOne({
            _id: oid(), name: 'Hall', owner, status: 'pending', address: { city: 'Pune' },
            createdAt: new Date(), updatedAt: new Date(),
        });

        const { venues } = await adminService.getVenues({});
        const o = venues[0].owner.toObject ? venues[0].owner.toObject() : venues[0].owner;
        expect(o.govIdStatus).toBe('pending');
        expect(o.name).toBe('Owner');
        expect(o.bankDetails).toBeUndefined();
        expect(o.password).toBeUndefined();
    });

    it('venue owners carry their ID status', async () => {
        const owner = await insertOwner({ govIdStatus: 'verified' });
        await db().collection('venues').insertOne({
            _id: oid(), name: 'Lawn', owner, status: 'approved', createdAt: new Date(), updatedAt: new Date(),
        });

        const { owners } = await adminService.getVenueOwners({});
        expect(owners).toHaveLength(1);
        expect(owners[0].govIdStatus).toBe('verified');
        expect(owners[0].venues).toHaveLength(1);
    });

    it('creators carry whether the owner is verified, but not bank details', async () => {
        const user = await insertOwner({ isVerified: true, verificationBadge: 'brand' });
        await db().collection('brandprofiles').insertOne({
            _id: oid(), user, name: 'Neon', type: 'brand', status: 'approved',
            createdAt: new Date(), updatedAt: new Date(),
        });

        const { brands } = await adminService.getBrands({});
        expect(brands[0].owner.isVerified).toBe(true);
        expect(brands[0].owner.verificationBadge).toBe('brand');
        expect(brands[0].owner.bankDetails).toBeUndefined();
    });
});
