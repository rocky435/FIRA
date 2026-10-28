/**
 * An event at a listed venue goes live only once the venue is paid for.
 *
 * It used to go live as soon as the venue owner and the admin approved it, with
 * a venue booking marked "payment pending" that nothing ever asked anyone to
 * pay - the event ran and the venue owner was never paid. Now:
 *  - the owner's approval holds the venue and opens a booking the organiser
 *    pays in FULL (no 10% advance for events), at the venue's day rate;
 *  - the event goes live when it is approved by both AND that booking is paid;
 *  - unpaid by the deadline, the event is cancelled and the days freed;
 *  - a paid venue is refunded in full if the event is then turned down.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import './setup';

const Event = require('../models/Event');
const Venue = require('../models/Venue');
const Booking = require('../models/Booking');
const Payment = require('../models/Payment');
const User = require('../models/User');
const eventService = require('../services/eventService');
const bookingService = require('../services/bookingService');
const refundService = require('../services/refundService');
const { expireUnpaidAcceptedBookings } = require('../jobs/scheduledJobs');

const DAY = 86400000;
let owner: any;
let organizer: any;
let venue: any;
let event: any;

const localAt = (daysOut: number, hh: number) => {
    const d = new Date(Date.now() + daysOut * DAY);
    d.setHours(hh, 0, 0, 0);
    return d;
};

async function pay(booking: any) {
    const payment = await Payment.create({
        user: organizer._id, type: 'venue_booking', referenceId: booking._id, referenceModel: 'Booking',
        amount: booking.totalAmount, subtotal: booking.totalAmount, listedPrice: booking.totalAmount,
        platformFee: 0, gstAmount: 0, totalAmount: booking.totalAmount, status: 'success', paidAt: new Date(),
        createdAt: new Date(),
    });
    return bookingService.fulfilConfirmedPayment(payment);
}

beforeEach(async () => {
    owner = await User.create({ name: 'Owner', email: `${new mongoose.Types.ObjectId()}@x.test`, password: 'x', roles: ['venue_owner'] });
    organizer = await User.create({ name: 'Org', email: `${new mongoose.Types.ObjectId()}@x.test`, password: 'x' });
    venue = await Venue.create({
        owner: owner._id, name: 'Lotus Hall', description: 'd', capacity: { min: 1, max: 100 }, status: 'approved',
        pricing: { basePrice: 10000, pricePerDay: 10000 },
        address: { street: 's', city: 'Hyderabad', state: 'TS', pincode: '500001' },
    });
    // A two-day event, 20 days out.
    event = await Event.create({
        organizer: organizer._id, venue: venue._id, name: 'Night Market', description: 'd', maxAttendees: 50,
        status: 'pending', startDateTime: localAt(20, 18), endDateTime: localAt(21, 22),
    });
});

describe('an event at a listed venue', () => {
    it("owner approval opens a full-price venue booking; the event waits for payment, then goes live", async () => {
        await eventService.venueApproveEvent(event._id, owner._id, { status: 'approved' });

        const booking = await Booking.findOne({ event: event._id }).lean();
        expect(booking).toMatchObject({
            status: 'accepted', paymentStatus: 'pending', totalAmount: 20000,
            paymentSchedule: { type: 'full', depositAmount: 20000, balanceAmount: 0 },
        });
        expect(booking.paymentDueAt).toBeTruthy();
        // The venue's days are held while the organiser pays.
        expect((await Venue.findById(venue._id).lean()).blockedDates.length).toBe(2);

        await eventService.adminApproveEvent(event._id, new mongoose.Types.ObjectId(), { status: 'approved' });
        expect((await Event.findById(event._id).lean()).status).toBe('pending');

        await pay(booking);
        expect((await Booking.findById(booking._id).lean()).paymentStatus).toBe('paid');
        expect((await Event.findById(event._id).lean()).status).toBe('approved');
    });

    it('paying before the admin approves: live the moment the admin approves', async () => {
        await eventService.venueApproveEvent(event._id, owner._id, { status: 'approved' });
        await pay(await Booking.findOne({ event: event._id }));
        expect((await Event.findById(event._id).lean()).status).toBe('pending');

        await eventService.adminApproveEvent(event._id, new mongoose.Types.ObjectId(), { status: 'approved' });
        expect((await Event.findById(event._id).lean()).status).toBe('approved');
    });

    it('unpaid by the deadline: the event is cancelled and the venue days are freed', async () => {
        await eventService.venueApproveEvent(event._id, owner._id, { status: 'approved' });
        await Booking.updateOne({ event: event._id }, { $set: { paymentDueAt: new Date(Date.now() - DAY) } });

        await expireUnpaidAcceptedBookings();

        expect((await Booking.findOne({ event: event._id }).lean()).status).toBe('cancelled');
        expect((await Event.findById(event._id).lean()).status).toBe('cancelled');
        expect((await Venue.findById(venue._id).lean()).blockedDates).toEqual([]);
    });

    it('a paid venue is refunded in full when the admin rejects the event', async () => {
        const spy = vi.spyOn(refundService, 'raiseBookingRefunds').mockResolvedValue({ amountPaid: 20000, refunds: [] });
        await eventService.venueApproveEvent(event._id, owner._id, { status: 'approved' });
        await pay(await Booking.findOne({ event: event._id }));

        await eventService.adminApproveEvent(event._id, new mongoose.Types.ObjectId(), { status: 'rejected', rejectionReason: 'no' });

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][1]).toBe(100);
        expect((await Booking.findOne({ event: event._id }).lean()).status).toBe('cancelled');
        spy.mockRestore();
    });

    it('checkout for an event venue always charges the full amount', async () => {
        const paymentService = require('../services/paymentService');
        const spy = vi.spyOn(paymentService, 'initiatePayment').mockResolvedValue({ orderId: 'o1' });
        await eventService.venueApproveEvent(event._id, owner._id, { status: 'approved' });
        const booking = await Booking.findOne({ event: event._id });

        await bookingService.initiateBookingPayment(booking._id, organizer._id, { plan: 'advance' });

        expect(spy.mock.calls[0][0].subtotal).toBe(20000);
        spy.mockRestore();
    });

    it("the venue booking can't be cancelled on its own, only with the event", async () => {
        const venueService = require('../services/venueService');
        await eventService.venueApproveEvent(event._id, owner._id, { status: 'approved' });
        const booking = await Booking.findOne({ event: event._id });
        await expect(venueService.processCancellation(booking._id, organizer._id)).rejects.toThrow(/Cancel the event instead/);
    });

    it('an organiser hosting at their own venue owes nothing', async () => {
        const own = await Event.create({
            organizer: owner._id, venue: venue._id, name: 'Own', description: 'd', maxAttendees: 5, status: 'pending',
            startDateTime: localAt(30, 18), endDateTime: localAt(30, 22),
        });
        await eventService.venueApproveEvent(own._id, owner._id, { status: 'approved' });
        await eventService.adminApproveEvent(own._id, new mongoose.Types.ObjectId(), { status: 'approved' });
        expect((await Event.findById(own._id).lean()).status).toBe('approved');
    });
});
