/**
 * "Events waiting for approval" on the dashboard and the nav badge must count
 * exactly what the Pending approvals tab lists.
 *
 * An event both the venue and the admin approved stays `pending` until the
 * organiser pays for the venue (eventService.goLiveIfReady). That is not admin
 * work: it used to be counted (status === 'pending') while the queue, which
 * looks at the admin's approval, correctly left it out - so the dashboard said
 * "3 waiting" and the tab said "All caught up".
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import './setup';

const adminService = require('../services/adminService');
const eventService = require('../services/eventService');

const db = () => mongoose.connection.db!;
const oid = () => new mongoose.Types.ObjectId();

async function insertEvent(name: string, extra: Record<string, unknown>) {
    await db().collection('events').insertOne({
        _id: oid(), name, organizer: oid(), venue: oid(), status: 'pending', eventType: 'public',
        startDateTime: new Date(Date.now() + 86400000), endDateTime: new Date(Date.now() + 90000000),
        createdAt: new Date(), updatedAt: new Date(), ...extra,
    });
}

describe('admin event queue count', () => {
    it('leaves out events only waiting for the venue to be paid', async () => {
        await insertEvent('needs-admin', { venueApproval: { status: 'approved' }, adminApproval: { status: 'pending' } });
        await insertEvent('needs-admin-and-venue', { venueApproval: { status: 'pending' }, adminApproval: { status: 'pending' } });
        await insertEvent('venue-unpaid', { venueApproval: { status: 'approved' }, adminApproval: { status: 'approved' } });
        await insertEvent('venue-unpaid-2', { venueApproval: { status: 'approved' }, adminApproval: { status: 'approved' } });
        await insertEvent('deleted', { adminApproval: { status: 'pending' }, isDeleted: true });
        await insertEvent('no-venue', { venue: null, adminApproval: { status: 'pending' } });
        await insertEvent('live', { status: 'approved', adminApproval: { status: 'approved' } });

        const queue = await eventService.getPendingAdminApproval({ limit: 50 });
        expect(queue.events.map((e: { name: string }) => e.name).sort()).toEqual(['needs-admin', 'needs-admin-and-venue']);

        const stats = await adminService.getStats();
        expect(stats.pendingEvents).toBe(queue.total);

        // Shown on the dashboard as their own row, and listed by the Events
        // page's "Venue not paid" filter.
        expect(stats.eventsVenueUnpaid).toBe(2);
        const unpaid = await adminService.getEvents({ status: 'venue_unpaid' });
        expect(unpaid.events.map((e: { name: string }) => e.name).sort()).toEqual(['venue-unpaid', 'venue-unpaid-2']);
    });
});
