/**
 * The admin Events list's Upcoming / Ongoing / Completed filters.
 *
 * Approval stores `approved`; nothing ever stores `upcoming`, so filtering on
 * that literal value always came back empty. These groups are decided by the
 * event's dates, so they are also right in the gap before the lifecycle job
 * next moves an event to `ongoing` or `completed`.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import './setup';

const adminService = require('../services/adminService');

const db = () => mongoose.connection.db!;
const HOUR = 3600 * 1000;
const at = (h: number) => new Date(Date.now() + h * HOUR);

async function insertEvent(name: string, status: string, startH: number, endH: number) {
    await db().collection('events').insertOne({
        _id: new mongoose.Types.ObjectId(), name, status, eventType: 'public',
        startDateTime: at(startH), endDateTime: at(endH),
        createdAt: new Date(), updatedAt: new Date(),
    });
}

const names = async (status: string, extra: Record<string, unknown> = {}) =>
    (await adminService.getEvents({ status, ...extra })).events.map((e: { name: string }) => e.name).sort();

describe('admin events — time groups', () => {
    it('groups by date, whatever the lifecycle job has written so far', async () => {
        await insertEvent('future-approved', 'approved', 24, 30);
        await insertEvent('future-upcoming', 'upcoming', 48, 50);
        await insertEvent('live-approved', 'approved', -1, 2); // job not run yet
        await insertEvent('live-ongoing', 'ongoing', -2, 3);
        await insertEvent('ended-approved', 'approved', -10, -5); // job not run yet
        await insertEvent('ended-ongoing', 'ongoing', -10, -1); // job not run yet
        await insertEvent('ended-completed', 'completed', -30, -20);
        await insertEvent('future-pending', 'pending', 24, 26);
        await insertEvent('future-blocked', 'blocked', 24, 26);
        await insertEvent('past-cancelled', 'cancelled', -30, -20);

        expect(await names('upcoming')).toEqual(['future-approved', 'future-upcoming']);
        expect(await names('ongoing')).toEqual(['live-approved', 'live-ongoing']);
        expect(await names('completed')).toEqual(['ended-approved', 'ended-completed', 'ended-ongoing']);
        // Manual states are still matched as stored.
        expect(await names('pending')).toEqual(['future-pending']);
        expect(await names('blocked')).toEqual(['future-blocked']);
        expect(await names('cancelled')).toEqual(['past-cancelled']);
    });

    it('lists upcoming soonest first and completed most recent first', async () => {
        await insertEvent('later', 'approved', 72, 74);
        await insertEvent('sooner', 'approved', 5, 6);
        await insertEvent('long-ago', 'completed', -100, -90);
        await insertEvent('yesterday', 'completed', -30, -24);

        const up = (await adminService.getEvents({ status: 'upcoming' })).events.map((e: { name: string }) => e.name);
        expect(up).toEqual(['sooner', 'later']);
        const done = (await adminService.getEvents({ status: 'completed' })).events.map((e: { name: string }) => e.name);
        expect(done).toEqual(['yesterday', 'long-ago']);
    });

    it('still combines with search', async () => {
        await insertEvent('Jazz Night', 'approved', 24, 26);
        await insertEvent('Rock Night', 'approved', 24, 26);
        expect(await names('upcoming', { search: 'jazz' })).toEqual(['Jazz Night']);
    });
});

describe('admin venues — blocked filter', () => {
    it('includes venues stored as suspended', async () => {
        const base = { createdAt: new Date(), updatedAt: new Date() };
        await db().collection('venues').insertMany([
            { name: 'A', status: 'blocked', ...base },
            { name: 'B', status: 'suspended', ...base },
            { name: 'C', status: 'approved', ...base },
        ]);
        const { venues } = await adminService.getVenues({ status: 'blocked' });
        expect(venues.map((v: { name: string }) => v.name).sort()).toEqual(['A', 'B']);
    });
});

describe('admin venue bookings — time groups', () => {
    const { localDayKey } = require('../utils/venueAvailability');
    const DAY = 24 * HOUR;
    // bookingDate / endDate are stored as UTC midnights of the local (IST) day.
    const dayAt = (offset: number) => new Date(Date.parse(`${localDayKey(new Date())}T00:00:00Z`) + offset * DAY);

    const label = new Map<string, string>();
    async function insertBooking(guest: string, status: string, startDay: number, endDay: number | null = null) {
        const _id = new mongoose.Types.ObjectId();
        label.set(String(_id), guest);
        await db().collection('bookings').insertOne({
            _id, venue: new mongoose.Types.ObjectId(), user: new mongoose.Types.ObjectId(),
            status, paymentStatus: 'paid', totalAmount: 1000,
            bookingDate: dayAt(startDay), endDate: endDay == null ? null : dayAt(endDay),
            startTime: '10:00', endTime: '18:00', createdAt: new Date(), updatedAt: new Date(),
        });
    }
    const guests = async (status: string) =>
        (await adminService.getBookings({ status })).bookings.map((b: { _id: unknown }) => label.get(String(b._id))).sort();

    it('groups accepted bookings by their days', async () => {
        await insertBooking('tomorrow', 'accepted', 1);
        await insertBooking('today', 'accepted', 0);
        await insertBooking('multi-day-now', 'accepted', -1, 1);
        await insertBooking('last-week', 'accepted', -7, -6); // owner never marked it done
        await insertBooking('marked-done', 'completed', -3);
        await insertBooking('future-pending', 'pending', 5);
        await insertBooking('future-cancelled', 'cancelled', 5);

        expect(await guests('upcoming')).toEqual(['tomorrow']);
        expect(await guests('ongoing')).toEqual(['multi-day-now', 'today']);
        expect(await guests('completed')).toEqual(['last-week', 'marked-done']);
        expect(await guests('pending')).toEqual(['future-pending']);
        expect(await guests('cancelled')).toEqual(['future-cancelled']);

        const { counts } = await adminService.getBookings({});
        expect(counts.upcoming).toBe(1);
        expect(counts.ongoing).toBe(2);
        expect(counts.completed).toBe(2);
        expect(counts.pending).toBe(1);
        expect(counts.all).toBe(7);
    });
});
