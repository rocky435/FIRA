/**
 * Messages that matter go to the phone (FCM) and browser push, not only the
 * inbox. The organiser's event decisions used to be written straight into the
 * Notification collection, skipping push entirely; refund and cancellation
 * messages were inbox-only. Each now goes through notificationService with
 * the push channel, so fcmService.sendToUsers is called for the right person.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import './setup';

delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const fcmService = require('../services/fcmService');
const pushService = require('../services/pushService');
const eventService = require('../services/eventService');
const adminService = require('../services/adminService');
const refundService = require('../services/refundService');
const Notification = require('../models/Notification');
const Event = require('../models/Event');

const db = () => mongoose.connection.db!;
const oid = () => new mongoose.Types.ObjectId();

let fcm: ReturnType<typeof vi.spyOn>;
let web: ReturnType<typeof vi.spyOn>;
let organizer: mongoose.Types.ObjectId;
let admin: mongoose.Types.ObjectId;

beforeEach(async () => {
    fcm = vi.spyOn(fcmService, 'sendToUsers').mockResolvedValue({ sent: 1, failed: 0 });
    web = vi.spyOn(pushService, 'sendToUsers').mockResolvedValue({ sent: 1, failed: 0 });
    organizer = oid();
    admin = oid();
    await db().collection('users').insertMany([
        { _id: organizer, name: 'Org', email: `o-${organizer}@x.test`, role: 'user', roles: ['user'] },
        { _id: admin, name: 'Admin', email: `a-${admin}@x.test`, role: 'admin', roles: ['admin'], adminRole: 'admin' },
    ]);
});
afterEach(() => vi.restoreAllMocks());

const pushedTo = (spy: any) => spy.mock.calls.map((c: any[]) => c[0].map(String)).flat();
const lastPayload = (spy: any) => spy.mock.calls.at(-1)[1];

async function makeEvent(extra: Record<string, unknown> = {}) {
    return (await Event.create({
        organizer, name: 'Garden Gig', description: 'd', maxAttendees: 50, status: 'pending',
        startDateTime: new Date(Date.now() + 10 * 864e5), endDateTime: new Date(Date.now() + 10.2 * 864e5),
        customVenue: { isCustom: true, name: 'Lawn', city: 'Pune' },
        venueApproval: { status: 'approved' }, adminApproval: { status: 'pending' },
        ...extra,
    }))._id;
}

describe('organiser event messages reach the phone', () => {
    it('admin approval', async () => {
        const id = await makeEvent();
        await eventService.adminApproveEvent(id, String(admin), { status: 'approved' });
        await vi.waitFor(() => expect(pushedTo(fcm)).toContain(String(organizer)));
        expect(pushedTo(web)).toContain(String(organizer));
        expect(lastPayload(fcm)).toMatchObject({ title: 'Your event was approved', url: `/dashboard/events/${id}` });
        // Still in the inbox.
        expect(await Notification.countDocuments({ user: organizer, title: 'Your event was approved' })).toBe(1);
    });

    it('admin rejection', async () => {
        const id = await makeEvent();
        await eventService.adminApproveEvent(id, String(admin), { status: 'rejected', rejectionReason: 'No address' });
        await vi.waitFor(() => expect(pushedTo(fcm)).toContain(String(organizer)));
        expect(lastPayload(fcm).body).toContain('No address');
    });

    it('venue owner approval', async () => {
        const owner = oid();
        const venue = oid();
        await db().collection('users').insertOne({ _id: owner, name: 'Owner', email: `v-${owner}@x.test`, role: 'venue_owner', roles: ['venue_owner'] });
        await db().collection('venues').insertOne({ _id: venue, owner, name: 'Lotus Hall', status: 'approved', isActive: true });
        const id = await makeEvent({ venue, customVenue: { isCustom: false }, venueApproval: { status: 'pending' } });
        await eventService.venueApproveEvent(id, owner, { status: 'approved' });
        await vi.waitFor(() => expect(pushedTo(fcm)).toContain(String(organizer)));
        expect(lastPayload(fcm).title).toBe('The venue approved your event');
    });

    it('blocked by an admin', async () => {
        const id = await makeEvent({ status: 'approved', adminApproval: { status: 'approved' } });
        await adminService.updateEventStatus(String(id), 'blocked', admin);
        await vi.waitFor(() => expect(pushedTo(fcm)).toContain(String(organizer)));
        expect(lastPayload(fcm).title).toBe('Your event was blocked');
    });
});

async function makeUser(name: string, extra: Record<string, unknown> = {}) {
    const _id = oid();
    await db().collection('users').insertOne({ _id, name, email: `${name}-${_id}@x.test`, role: 'user', roles: ['user'], ...extra });
    return _id;
}
async function makeVenue(owner: mongoose.Types.ObjectId, extra: Record<string, unknown> = {}) {
    const _id = oid();
    await db().collection('venues').insertOne({ _id, owner, name: 'Lotus Hall', status: 'approved', isActive: true, isDeleted: false, address: { city: 'Pune' }, ...extra });
    return _id;
}
const titlesTo = (spy: any, userId: mongoose.Types.ObjectId) =>
    spy.mock.calls.filter((c: any[]) => c[0].map(String).includes(String(userId))).map((c: any[]) => c[1].title);

describe('owners hear about admin decisions', () => {
    it('venue blocked, then unblocked', async () => {
        const owner = await makeUser('owner', { govIdStatus: 'verified' });
        const venue = await makeVenue(owner);
        await adminService.updateVenueStatus(String(venue), 'blocked', admin);
        await adminService.updateVenueStatus(String(venue), 'approved', admin);
        await vi.waitFor(() => expect(titlesTo(fcm, owner)).toEqual(['Your venue was blocked', 'Your venue is visible again']));
    });

    it('creator profile approved', async () => {
        const creator = await makeUser('creator');
        const brand = oid();
        await db().collection('brandprofiles').insertOne({ _id: brand, user: creator, name: 'Bassline', type: 'dj', status: 'pending' });
        await adminService.updateBrandStatus(String(brand), 'approved', admin);
        await vi.waitFor(() => expect(titlesTo(fcm, creator)).toEqual(['Your creator profile is approved']));
    });

    it('admin removes a venue and an event', async () => {
        const owner = await makeUser('owner2');
        const venue = await makeVenue(owner);
        await adminService.deleteVenue(String(venue), admin);
        const id = await makeEvent({ status: 'approved' });
        await adminService.deleteEvent(String(id), admin);
        await vi.waitFor(() => expect(titlesTo(fcm, owner)).toContain('Your venue was removed'));
        await vi.waitFor(() => expect(titlesTo(fcm, organizer)).toContain('Your event was removed'));
    });

    it('a new event request at their venue', async () => {
        const owner = await makeUser('owner3');
        const venue = await makeVenue(owner, { capacity: { min: 1, max: 500 }, pricing: { basePrice: 1000, pricePerDay: 1000 } });
        const event = await eventService.createEvent({
            organizer, venue: String(venue), name: 'Jazz Night', description: 'Live jazz', category: 'music', maxAttendees: 50,
            startDateTime: new Date(Date.now() + 20 * 864e5), endDateTime: new Date(Date.now() + 20.2 * 864e5),
        });
        await vi.waitFor(() => expect(titlesTo(fcm, owner)).toEqual(['New event request']));
        expect(lastPayload(fcm).url).toBe(`/venue-portal/events/${event._id}`);
    });
});

describe('guests hear about their events', () => {
    it('free ticket holders when the event is cancelled', async () => {
        const guest = await makeUser('guest');
        const id = await makeEvent({ status: 'approved' });
        await db().collection('tickets').insertOne({ _id: oid(), ticketId: 'FREE-1', user: guest, event: id, ticketType: 'General', price: 0, quantity: 1, status: 'active' });
        await eventService.cancelEvent(String(id), 'Rain');
        await vi.waitFor(() => expect(titlesTo(fcm, guest)).toEqual(['Event cancelled']));
    });

    it('ticket holders when the event details change, in plain words', async () => {
        const guest = await makeUser('guest2');
        const id = await makeEvent({ status: 'approved' });
        await db().collection('tickets').insertOne({ _id: oid(), ticketId: 'T-1', user: guest, event: id, ticketType: 'General', price: 100, quantity: 1, status: 'active' });
        const event = await Event.findById(id);
        await require('../services/notificationService').sendEventUpdateNotifications(event, ['name', 'description'], { _id: organizer });
        await vi.waitFor(() => expect(titlesTo(fcm, guest)).toEqual(['Event updated: Garden Gig']));
        expect(lastPayload(fcm).body).toBe('Your event has changed: new name "Garden Gig"; the description was updated. Check the event page for details.');
    });

    it('the 1-hour reminder pops up, once per person', async () => {
        const guest = await makeUser('guest3');
        const id = await makeEvent({ status: 'approved', startDateTime: new Date(Date.now() + 60 * 60 * 1000 - 60000), endDateTime: new Date(Date.now() + 3 * 3600 * 1000) });
        // Two tickets, one person: one reminder.
        await db().collection('tickets').insertMany([
            { _id: oid(), ticketId: 'R-1', user: guest, event: id, ticketType: 'General', price: 100, quantity: 1, status: 'active' },
            { _id: oid(), ticketId: 'R-2', user: guest, event: id, ticketType: 'General', price: 100, quantity: 1, status: 'active' },
        ]);
        vi.spyOn(require('../services/emailService'), 'sendEventReminderEmail').mockResolvedValue(true);
        await require('../jobs/scheduledJobs').sendEventReminders();
        await vi.waitFor(() => expect(titlesTo(fcm, guest)).toEqual(['Your event starts in 1 hour']));
        expect(await Notification.countDocuments({ user: guest, type: 'event_reminder_1h' })).toBe(1);
    });

    it('an organiser post reaches ticket holders', async () => {
        const guest = await makeUser('guest4');
        const id = await makeEvent({ status: 'approved' });
        await db().collection('tickets').insertOne({ _id: oid(), ticketId: 'P-1', user: guest, event: id, ticketType: 'General', price: 100, quantity: 1, status: 'active' });
        await require('../services/postService').createEventPost(String(id), organizer, { content: 'Doors open at 7' });
        await vi.waitFor(() => expect(titlesTo(fcm, guest)).toEqual(['New update from Garden Gig']));
    });

    it('private event: the request reaches the organiser, the answer reaches the guest', async () => {
        const guest = await makeUser('guest5');
        const id = await makeEvent({ status: 'approved', eventType: 'private', privateCode: 'SECRET12' });
        const request = await eventService.requestPrivateAccess(String(id), { userId: guest, accessCode: 'SECRET12', message: 'Friend of the band' });
        await vi.waitFor(() => expect(titlesTo(fcm, organizer)).toEqual(['New request to join your private event']));
        await eventService.handleAccessRequest(String(request._id), 'approved', { eventId: String(id), actorId: organizer });
        await vi.waitFor(() => expect(titlesTo(fcm, guest)).toEqual(["You're in!"]));
    });
});

describe('venue bookings: payments and cancellations', () => {
    it('advance and balance payments notify the guest and the owner', async () => {
        const owner = await makeUser('owner4');
        const guest = await makeUser('guest6');
        const venue = await makeVenue(owner);
        const bookingId = oid();
        await db().collection('bookings').insertOne({
            _id: bookingId, venue, user: guest, bookingDate: new Date(Date.now() + 30 * 864e5), endDate: new Date(Date.now() + 30 * 864e5),
            status: 'accepted', paymentStatus: 'pending', totalAmount: 10000,
            paymentSchedule: { type: 'installment', depositAmount: 1000, balanceAmount: 9000, balanceStatus: 'not_applicable' },
        });
        const bookingService = require('../services/bookingService');
        const advance = { _id: oid(), user: guest, type: 'venue_booking', referenceModel: 'Booking', referenceId: bookingId, amount: 1000, subtotal: 1000, totalAmount: 1000, status: 'success' };
        await db().collection('payments').insertOne(advance);
        await bookingService.fulfilConfirmedPayment(advance);
        await vi.waitFor(() => expect(titlesTo(fcm, guest)).toEqual(['Payment received - booking confirmed']));
        expect(titlesTo(fcm, owner)).toEqual(['Booking confirmed - guest paid']);

        const balance = { _id: oid(), user: guest, type: 'venue_booking', referenceModel: 'Booking', referenceId: bookingId, amount: 9000, subtotal: 9000, totalAmount: 9000, status: 'success' };
        await db().collection('payments').insertOne(balance);
        await bookingService.fulfilConfirmedPayment(balance);
        await vi.waitFor(() => expect(titlesTo(fcm, guest)).toContain('Balance paid - booking fully paid'));
        await vi.waitFor(() => expect(titlesTo(fcm, owner)).toContain('Booking fully paid'));
    });

    it('the venue owner hears when an event booked at their venue is cancelled, not when they declined it', async () => {
        const owner = await makeUser('owner5');
        const venue = await makeVenue(owner);
        const id = await makeEvent({ status: 'approved', venue, customVenue: { isCustom: false }, adminApproval: { status: 'approved' } });
        await db().collection('bookings').insertOne({ _id: oid(), venue, user: organizer, event: id, bookingDate: new Date(Date.now() + 10 * 864e5), status: 'accepted', paymentStatus: 'pending', totalAmount: 5000 });
        await eventService.cancelEvent(String(id), 'Artist cancelled');
        await vi.waitFor(() => expect(titlesTo(fcm, owner)).toEqual(['Event at your venue cancelled']));
        expect(lastPayload(fcm).body).toContain('artist cancelled');

        // Declined by the owner: no message to the owner.
        fcm.mockClear();
        const declined = await makeEvent({ venue, customVenue: { isCustom: false }, venueApproval: { status: 'pending' } });
        await db().collection('bookings').insertOne({ _id: oid(), venue, user: organizer, event: declined, bookingDate: new Date(Date.now() + 12 * 864e5), status: 'pending', paymentStatus: 'pending', totalAmount: 5000 });
        await eventService.venueApproveEvent(declined, owner, { status: 'rejected', rejectionReason: 'Closed that day' });
        await vi.waitFor(() => expect(titlesTo(fcm, organizer)).toContain('The venue declined your event'));
        expect(titlesTo(fcm, owner)).toEqual([]);
    });
});

describe('money messages reach the phone', () => {
    it('refund decided', async () => {
        const customer = oid();
        const payment = oid();
        await db().collection('users').insertOne({ _id: customer, name: 'Buyer', email: `b-${customer}@x.test`, role: 'user', roles: ['user'] });
        await db().collection('payments').insertOne({ _id: payment, user: customer, type: 'ticket', referenceModel: 'Event', referenceId: oid(), amount: 500, totalAmount: 500, status: 'success' });
        const refundId = oid();
        await db().collection('refunds').insertOne({ _id: refundId, payment, user: customer, reason: 'user_request', amount: 500, status: 'pending', requestedAt: new Date() });

        await refundService.processRefundRequest(String(refundId), admin, 'reject', 'Duplicate request');
        await vi.waitFor(() => expect(pushedTo(fcm)).toContain(String(customer)));
        expect(lastPayload(fcm).title).toBe('Refund not approved');
    });
});
