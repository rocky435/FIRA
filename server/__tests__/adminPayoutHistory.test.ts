/**
 * The "Past" tab on Organiser payouts and Venue owner payouts: every transfer
 * an admin recorded, newest first, with who was paid, for which listing, the
 * bank reference, and whether it was later reversed.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import './setup';

const adminService = require('../services/adminService');

const db = () => mongoose.connection.db!;
const oid = () => new mongoose.Types.ObjectId();

async function seed() {
    const admin = oid();
    const organiser = oid();
    const owner = oid();
    await db().collection('users').insertMany([
        { _id: admin, name: 'Sam Admin', email: 'sam@x.test' },
        { _id: organiser, name: 'Priya', email: 'priya@x.test' },
        { _id: owner, name: 'Ravi', email: 'ravi@x.test' },
    ]);
    const event = oid();
    const venue = oid();
    await db().collection('events').insertOne({ _id: event, name: 'Jazz Night', organizer: organiser });
    await db().collection('venues').insertOne({ _id: venue, name: 'Lotus Hall', owner });
    const at = (d: number) => new Date(Date.UTC(2026, 10, d, 10));
    const paid = oid();
    const mistaken = oid();
    // Every real ledger row carries a unique idempotency key.
    let key = 0;
    const k = () => `key-${++key}`;
    await db().collection('settlements').insertMany([
        { _id: paid, listingKind: 'event', listing: event, listingModel: 'Event', recipient: organiser, settledAmount: 4000, settlementReference: 'UTR111', settledAt: at(5), method: 'manual', recordedBy: admin, adminNotes: 'First half', idempotencyKey: k() },
        { _id: mistaken, listingKind: 'event', listing: event, listingModel: 'Event', recipient: organiser, settledAmount: 999, settlementReference: 'UTR222', settledAt: at(6), method: 'manual', recordedBy: admin, idempotencyKey: k() },
        { _id: oid(), listingKind: 'event', listing: event, listingModel: 'Event', recipient: organiser, settledAmount: -999, settledAt: at(7), method: 'manual', recordedBy: admin, isReversalOf: mistaken, reversalReason: 'Wrong amount', idempotencyKey: k() },
        { _id: oid(), listingKind: 'venue', listing: venue, listingModel: 'Venue', recipient: owner, settledAmount: 2500, settlementReference: 'UTR333', settledAt: at(8), method: 'manual', recordedBy: admin, idempotencyKey: k() },
    ]);
    return { event, venue };
}

describe('payout history', () => {
    it('lists organiser transfers, newest first, with reversals marked', async () => {
        const { event } = await seed();
        const res = await adminService.getPayoutHistory({ kind: 'event' });
        expect(res.payouts.map((p: any) => p.reference)).toEqual(['UTR222', 'UTR111']);
        const [reversed, first] = res.payouts;
        expect(reversed.reversed).toMatchObject({ reason: 'Wrong amount' });
        expect(first).toMatchObject({
            amount: 4000, method: 'manual', notes: 'First half', reversed: null,
            recipient: { name: 'Priya' }, recordedBy: 'Sam Admin',
            listing: { name: 'Jazz Night', link: `/events/${event}` },
        });
        // Paid out = transfers that stand.
        expect(res.totalPaid).toBe(4000);
    });

    it('venue owner transfers are separate, and search finds by name or reference', async () => {
        await seed();
        const venue = await adminService.getPayoutHistory({ kind: 'venue' });
        expect(venue.payouts).toHaveLength(1);
        expect(venue.payouts[0]).toMatchObject({ amount: 2500, recipient: { name: 'Ravi' }, listing: { name: 'Lotus Hall' } });
        expect((await adminService.getPayoutHistory({ kind: 'event', search: 'UTR111' })).payouts).toHaveLength(1);
        expect((await adminService.getPayoutHistory({ kind: 'event', search: 'jazz' })).payouts).toHaveLength(2);
        expect((await adminService.getPayoutHistory({ kind: 'event', search: 'ravi' })).payouts).toHaveLength(0);
    });
});
