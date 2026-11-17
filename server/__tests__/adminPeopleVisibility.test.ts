/**
 * People the admin could not see:
 *
 * - venue owners who have signed up as hosts but listed no venue yet (the list
 *   was built from venues, so they never appeared);
 * - organisers FIRA has marked (badge or approved creator profile) who have not
 *   created an event yet (the list was built from events).
 *
 * And removing someone's venue-owner access without deleting their account:
 * the role goes, their ID review starts again, everything else stays.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import './setup';

const adminService = require('../services/adminService');

const db = () => mongoose.connection.db!;
const oid = () => new mongoose.Types.ObjectId();

async function makeUser(name: string, extra: Record<string, unknown> = {}) {
    const _id = oid();
    await db().collection('users').insertOne({ _id, name, email: `${name}-${_id}@x.test`, role: 'user', roles: ['user'], ...extra });
    return _id;
}

describe('Venue Owners list', () => {
    it('includes hosts with no venue yet, and owners with venues', async () => {
        const newHost = await makeUser('NewHost', { role: 'venue_owner', roles: ['user', 'venue_owner'], businessName: 'Lotus Events' });
        const listed = await makeUser('Listed', { roles: ['user', 'venue_owner'] });
        await db().collection('venues').insertOne({ _id: oid(), owner: listed, name: 'Hall', status: 'approved' });
        await makeUser('JustAUser');

        const { owners } = await adminService.getVenueOwners({});
        const byName = Object.fromEntries(owners.map((o: any) => [o.name, o]));
        expect(Object.keys(byName).sort()).toEqual(['Listed', 'NewHost']);
        expect(byName.NewHost.venues).toEqual([]);
        expect(byName.Listed.venues).toHaveLength(1);
    });

    it('search still narrows the list', async () => {
        await makeUser('Asha', { roles: ['user', 'venue_owner'] });
        await makeUser('Bala', { roles: ['user', 'venue_owner'] });
        const { owners } = await adminService.getVenueOwners({ search: 'ash' });
        expect(owners.map((o: any) => o.name)).toEqual(['Asha']);
    });
});

describe('Remove venue-owner access', () => {
    it('takes away the venue-owner side only, and the ID is reviewed again next time', async () => {
        const admin = await makeUser('Admin', { role: 'admin', roles: ['admin'], adminRole: 'super_admin' });
        const host = await makeUser('Host', {
            role: 'venue_owner', roles: ['user', 'venue_owner'], businessName: 'Lotus', businessPhone: '9999999999',
            govIdType: 'aadhar', govIdNumber: '1234', govIdDocument: 'doc.png', govIdStatus: 'verified', govIdVerified: true,
            bankDetails: { accountNumber: '123', ifscCode: 'HDFC0000001' },
        });

        await adminService.removeVenueOwnerAccess(String(host), admin);

        const after: any = await db().collection('users').findOne({ _id: host });
        expect(after).toBeTruthy(); // the account itself is kept
        expect(after.roles).toEqual(['user']);
        expect(after.role).toBe('user');
        expect(after.govIdStatus).toBe('none');
        expect(after.govIdVerified).toBe(false);
        expect(after.govIdDocument).toBeNull();
        expect(after.businessName).toBeNull();
        expect(after.bankDetails.accountNumber).toBe('123'); // still used for organiser payouts

        const log: any = await db().collection('auditlogs').findOne({ entityId: host });
        expect(log).toMatchObject({ action: 'update', entityType: 'user' });
        expect(log.metadata.field).toBe('venueOwnerAccess');
    });

    it('refuses while the owner still has a venue on FIRA', async () => {
        const admin = await makeUser('Admin', { role: 'admin', roles: ['admin'], adminRole: 'super_admin' });
        const host = await makeUser('Host', { roles: ['user', 'venue_owner'] });
        await db().collection('venues').insertOne({ _id: oid(), owner: host, name: 'Hall', status: 'approved' });
        await expect(adminService.removeVenueOwnerAccess(String(host), admin)).rejects.toThrow(/venue/i);
        const after: any = await db().collection('users').findOne({ _id: host });
        expect(after.roles).toContain('venue_owner');
    });

    it('allows it when their only venues were deleted', async () => {
        const admin = await makeUser('Admin', { role: 'admin', roles: ['admin'], adminRole: 'super_admin' });
        const host = await makeUser('Host', { roles: ['user', 'venue_owner'] });
        await db().collection('venues').insertOne({ _id: oid(), owner: host, name: 'Old', status: 'approved', isDeleted: true });
        await adminService.removeVenueOwnerAccess(String(host), admin);
        const after: any = await db().collection('users').findOne({ _id: host });
        expect(after.roles).toEqual(['user']);
    });

    it('refuses for someone who is not a venue owner', async () => {
        const admin = await makeUser('Admin', { role: 'admin', roles: ['admin'], adminRole: 'super_admin' });
        const plain = await makeUser('Plain');
        await expect(adminService.removeVenueOwnerAccess(String(plain), admin)).rejects.toThrow(/not a venue owner/i);
    });
});

describe('Event Organisers list', () => {
    it('includes marked organisers who have not created an event yet', async () => {
        const withEvent = await makeUser('Maker');
        await db().collection('events').insertOne({ _id: oid(), name: 'Gig', organizer: withEvent, status: 'approved', startDateTime: new Date(), endDateTime: new Date() });
        await makeUser('Badged', { isVerified: true, verificationBadge: 'organizer' });
        const creator = await makeUser('Creator');
        await db().collection('brandprofiles').insertOne({ _id: oid(), user: creator, name: 'Neon', type: 'brand', status: 'approved' });
        const applicant = await makeUser('Applicant');
        await db().collection('brandprofiles').insertOne({ _id: oid(), user: applicant, name: 'Maybe', type: 'brand', status: 'pending' });
        await makeUser('Nobody');

        const { organisers } = await adminService.getEventOrganisers({});
        const names = organisers.map((o: any) => o.name).sort();
        expect(names).toEqual(['Badged', 'Creator', 'Maker']);
        const badged = organisers.find((o: any) => o.name === 'Badged');
        expect(badged.counts.total).toBe(0);
    });
});
