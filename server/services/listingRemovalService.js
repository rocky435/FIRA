// @ts-check
/**
 * Removing things customers have paid for.
 *
 * - An event with sold tickets, or a venue with upcoming bookings/events, cannot
 *   be removed by its owner: the owner's request is recorded for an admin, who
 *   removes it from the admin panel. Removing a paid-for listing cancels what was
 *   sold and raises the refunds in the admin "Refunds to be done" queue.
 * - An account cannot be deleted while it has anything upcoming or ongoing - as
 *   an organizer, a venue owner, or a customer. The holder is shown what is left.
 *
 * Deleting used to cascade straight through: an organizer could sell tickets and
 * delete the event (or their whole account) and every buyer was left with nothing.
 */

const Event = require('../models/Event');
const Venue = require('../models/Venue');
const Booking = require('../models/Booking');
const Ticket = require('../models/Ticket');

// Typed loosely: the query typings want each model's literal status union.
/** @type {any[]} */
const LIVE_EVENT_STATUSES_EXCLUDED = ['cancelled', 'rejected', 'completed'];
/** @type {any[]} */
const OPEN_BOOKING_STATUSES = ['pending', 'accepted'];

/** Midnight UTC today - bookingDate/endDate are stored as UTC midnights. */
function startOfToday() {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Bookings whose last day is today or later.
 * @returns {any}
 */
function upcomingBookingFilter() {
    const today = startOfToday();
    return {
        status: { $in: OPEN_BOOKING_STATUSES },
        $or: [{ endDate: { $gte: today } }, { bookingDate: { $gte: today } }],
    };
}

/**
 * Events that have not ended and are not cancelled/rejected/completed.
 * @returns {any}
 */
function liveEventFilter() {
    return {
        isDeleted: { $ne: true },
        status: { $nin: LIVE_EVENT_STATUSES_EXCLUDED },
        endDateTime: { $gte: new Date() },
    };
}

const brief = {
    event: (e) => ({ _id: e._id, name: e.name, startDateTime: e.startDateTime, status: e.status }),
    booking: (b) => ({ _id: b._id, bookingDate: b.bookingDate, startTime: b.startTime, status: b.status, venue: b.venue?.name || null }),
};

/** Whether customers hold tickets (active or already used) for this event. */
async function eventHasSales(eventId) {
    return !!(await Ticket.exists({ event: eventId, status: { $in: /** @type {any[]} */ (['active', 'used']) } }));
}

/** Upcoming bookings and live events at a venue. */
async function venueObligations(venueId) {
    const [bookings, events] = await Promise.all([
        Booking.find({ venue: venueId, ...upcomingBookingFilter() }).select('bookingDate startTime status').lean(),
        Event.find({ venue: venueId, ...liveEventFilter() }).select('name startDateTime status').lean(),
    ]);
    return { bookings: bookings.map(brief.booking), events: events.map(brief.event) };
}

/** Record an owner's request to remove a listing, for admin review. */
async function requestRemoval(Model, id, userId, reason) {
    return Model.findByIdAndUpdate(
        id,
        { $set: { deletionRequest: { requestedAt: new Date(), requestedBy: userId, reason: reason || null } } },
        { new: true }
    );
}

/**
 * Everything that has to be finished before this account can be deleted. Empty
 * lists mean nothing is upcoming or ongoing.
 */
async function accountDeletionBlockers(userId) {
    const venueIds = (await Venue.find({ owner: userId, isDeleted: { $ne: true } }).select('_id').lean()).map(v => v._id);

    const [myEvents, venueBookings, venueEvents, tickets, bookings] = await Promise.all([
        Event.find({ organizer: userId, ...liveEventFilter() }).select('name startDateTime status').lean(),
        venueIds.length
            ? Booking.find({ venue: { $in: venueIds }, ...upcomingBookingFilter() }).populate('venue', 'name').select('bookingDate startTime status venue').lean()
            : [],
        venueIds.length
            ? Event.find({ venue: { $in: venueIds }, organizer: { $ne: userId }, ...liveEventFilter() }).select('name startDateTime status').lean()
            : [],
        Ticket.find({ user: userId, status: 'active' }).populate('event', 'name startDateTime endDateTime status').select('event').lean(),
        Booking.find({ user: userId, ...upcomingBookingFilter() }).populate('venue', 'name').select('bookingDate startTime status venue').lean(),
    ]);

    const now = Date.now();
    // `event` is populated above.
    const liveTickets = tickets.filter((/** @type {any} */ t) => t.event && !['cancelled', 'completed'].includes(t.event.status)
        && new Date(t.event.endDateTime).getTime() >= now);

    return {
        events: myEvents.map(brief.event),
        venueBookings: venueBookings.map(brief.booking),
        venueEvents: venueEvents.map(brief.event),
        tickets: liveTickets.map((/** @type {any} */ t) => brief.event(t.event)),
        bookings: bookings.map(brief.booking),
    };
}

const hasAny = (blockers) => Object.values(blockers).some(list => list.length > 0);

/**
 * Admin removal of a venue's upcoming bookings: each is cancelled, its dates
 * released, and what the guest paid (deposit, plus balance if paid - not the
 * platform fee or GST) raised as a refund request. The guest did nothing wrong,
 * so it is a full refund of those amounts.
 */
async function cancelVenueBookingsForRemoval(venueId) {
    const refundService = require('./refundService');
    const notificationService = require('./notificationService');
    const bookings = await Booking.find({ venue: venueId, ...upcomingBookingFilter() });
    for (const booking of bookings) {
        const claimed = await Booking.findOneAndUpdate(
            { _id: booking._id, status: { $in: OPEN_BOOKING_STATUSES } },
            { $set: { status: 'cancelled', cancellationReason: 'venue_removed' } }
        );
        if (!claimed) continue;

        const { refunds } = await refundService.raiseBookingRefunds(booking, 100, {
            reasonDetails: `Venue removed by FIRA - booking ${booking._id} cancelled`,
        });
        notificationService.createNotification({
            userId: booking.user,
            type: 'booking_cancelled',
            title: 'Booking cancelled',
            message: refunds.length
                ? 'The venue for your booking is no longer on FIRA, so your booking is cancelled. What you paid will be refunded.'
                : 'The venue for your booking is no longer on FIRA, so your booking is cancelled.',
            data: { referenceId: booking._id, referenceModel: 'Booking', actionUrl: '/dashboard/bookings' },
            priority: 'high'
        }).catch(() => {});
    }
    return bookings.length;
}

module.exports = {
    eventHasSales,
    venueObligations,
    requestRemoval,
    accountDeletionBlockers,
    hasAny,
    cancelVenueBookingsForRemoval,
};
