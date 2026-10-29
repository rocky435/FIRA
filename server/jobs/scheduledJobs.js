/**
 * Scheduled Jobs for FIRA
 * Uses node-cron to run periodic tasks
 */

const cron = require('node-cron');
const Ticket = require('../models/Ticket');
const Event = require('../models/Event');
const User = require('../models/User');
const Notification = require('../models/Notification');
const Booking = require('../models/Booking');
const Venue = require('../models/Venue');
const emailService = require('../services/emailService');
const notificationService = require('../services/notificationService');
const { REMINDER_WINDOW_HOURS, BALANCE_DUE_HOURS_BEFORE } = require('../utils/paymentSchedule');
const { releaseBookingDays, dayKey, localDayKey } = require('../utils/venueAvailability');

/**
 * Event statuses that mean "live and not yet started/finished". `approved` is what
 * the approval flow sets; `upcoming` is an equally valid schema value used by the
 * seeds. Both jobs below key off this one list so they cannot disagree.
 */
const LIVE_EVENT_STATUSES = ['approved', 'upcoming'];

/**
 * Send event reminders 1 hour before events start
 * Runs every 10 minutes
 *
 * ponytail: Batch-fetches all tickets for all upcoming events in a single query
 * (eliminates N+1 per-event ticket lookup). Notifications are still created
 * individually because Mongoose doesn't return per-doc errors from insertMany
 * with ordered:false in a useful way, but the heavy DB reads are O(1) not O(N).
 */
async function sendEventReminders() {
    try {
        const now = new Date();
        const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
        const fiftyMinutesFromNow = new Date(now.getTime() + 50 * 60 * 1000);

        // Find events starting within 50-70 minutes (1 hour ± 10 minutes)
        // 'approved' is what the approval flow sets, but 'upcoming' is an equally
        // valid live status (the seeds use it) - matching only 'approved' silently
        // skipped reminders for those events.
        const upcomingEvents = await Event.find({
            startDateTime: {
                $gte: fiftyMinutesFromNow,
                $lte: oneHourFromNow
            },
            status: { $in: LIVE_EVENT_STATUSES }
        }).populate('venue', 'name address');

        if (upcomingEvents.length === 0) {
            return;
        }

        const eventIds = upcomingEvents.map(e => e._id);
        const eventMap = new Map(upcomingEvents.map(e => [e._id.toString(), e]));

        console.log(`📅 Found ${upcomingEvents.length} events starting in ~1 hour`);

        // Single query for ALL tickets across all upcoming events (eliminates N+1)
        const tickets = await Ticket.find({
            event: { $in: eventIds },
            status: 'active',
            reminderSent: { $ne: true }
        }).populate('user', 'name email');

        if (tickets.length === 0) {
            console.log('✅ No pending reminders to send');
            return;
        }

        console.log(`  📧 Sending ${tickets.length} reminders across ${upcomingEvents.length} events`);

        // Bulk-create notifications
        const notifications = tickets.map(ticket => ({
            user: ticket.user._id,
            type: 'event_reminder_1h',
            title: 'Your event starts in 1 hour',
            message: `${eventMap.get(ticket.event.toString()).name} starts in 1 hour! Don't forget your ticket.`,
            data: {
                referenceId: ticket.event,
                referenceModel: 'Event',
                actionUrl: `/events/${ticket.event}`,
                extra: { ticketId: ticket.ticketId }
            },
            priority: 'high',
            channel: 'all'
        }));

        await Notification.insertMany(notifications, { ordered: false }).catch(err => {
            // Log but don't abort — some may have succeeded
            console.error('  ⚠️ Some notifications failed to insert:', err.message);
        });

        // Send emails (IO-bound, can't avoid per-ticket, but DB reads are done)
        for (const ticket of tickets) {
            const event = eventMap.get(ticket.event.toString());
            try {
                await emailService.sendEventReminderEmail(
                    ticket.user.email,
                    ticket.user.name,
                    event,
                    ticket
                );
            } catch (err) {
                console.error(`  ❌ Failed to email reminder for ticket ${ticket.ticketId}:`, err.message);
            }
        }

        // Bulk-mark all tickets as reminded (single query)
        const ticketIds = tickets.map(t => t._id);
        await Ticket.updateMany(
            { _id: { $in: ticketIds } },
            { $set: { reminderSent: true } }
        );

        console.log('✅ Event reminders job completed');
    } catch (error) {
        console.error('❌ Event reminders job failed:', error.message);
    }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Grace after a payment deadline before cancelling, for a checkout already under way. */
const PAYMENT_GRACE_MS = 30 * 60 * 1000;

/**
 * Whole calendar days from today (server-local, IST in production) to the day of
 * the booking: 2 on the 8th for a booking on the 10th.
 */
function daysUntilBookingDay(bookingDate, now) {
    return Math.round((Date.parse(`${dayKey(bookingDate)}T00:00:00Z`) - Date.parse(`${localDayKey(now)}T00:00:00Z`)) / MS_PER_DAY);
}

const formatWhen = (date) => new Date(date).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Send daily balance-payment reminders for installment bookings whose 90% balance
 * is still pending and whose deadline has not yet passed (Req 7).
 *
 * Reminders only start once the event is within REMINDER_WINDOW_HOURS (7 days).
 * The deadline itself is 24h before the event, so the window is expressed on
 * balanceDueAt: due within (7 days − 24h) of now. A guest who books two months
 * out is not nagged daily for seven weeks.
 *
 * `lastReminderOn` ('YYYY-MM-DD', server local date) dedupes to at most one email +
 * one push per booking per calendar day (Req 7.1) and makes the job idempotent
 * within a day. Bookings past their deadline are skipped here and left for
 * enforceBalanceDeadlines (Req 7.3). Once balanceStatus leaves 'pending' the query
 * excludes the booking, so reminders stop automatically (Req 7.4, Property 5).
 *
 * ponytail: mirrors sendEventReminders — batch read, per-item email in try/catch,
 * exported for tests.
 */
async function sendBalanceReminders() {
    try {
        const now = new Date();
        // Two days before the booking the unpaid balance gets the final notice
        // instead of the usual reminder.
        await sendBalanceFinalNotices(now);

        // en-CA yields YYYY-MM-DD in server local time — stable string key for once-per-day dedupe.
        const today = now.toLocaleDateString('en-CA');
        const remindFrom = new Date(
            now.getTime() + (REMINDER_WINDOW_HOURS - BALANCE_DUE_HOURS_BEFORE) * 3600 * 1000
        );

        const bookings = await Booking.find({
            'paymentSchedule.type': 'installment',
            'paymentSchedule.balanceStatus': 'pending',
            paymentStatus: 'paid', // the deposit was actually paid - no balance chasing for an abandoned checkout
            status: 'accepted', // the venue accepted it - the balance is only due on an accepted booking
            // Req 7.3: skip past-deadline (left for enforcement); and not before the
            // event is 7 days out.
            'paymentSchedule.balanceDueAt': { $gt: now, $lte: remindFrom },
            'paymentSchedule.lastReminderOn': { $ne: today },   // Req 7.1: at most once per calendar day
            $or: [
                { 'paymentSchedule.finalNoticeSentAt': null },
                { 'paymentSchedule.finalNoticeSentAt': { $lt: new Date(now.getTime() - 12 * 3600 * 1000) } },
            ],
        })
            .populate('user', 'name email')
            .populate('venue', 'name');

        if (bookings.length === 0) {
            await sendDayBeforeReminders(now);
            return;
        }

        console.log(`💰 Sending balance reminders for ${bookings.length} booking(s)`);

        for (const booking of bookings) {
            const { balanceAmount, balanceDueAt } = booking.paymentSchedule;
            const daysLeft = Math.ceil((new Date(balanceDueAt) - now) / MS_PER_DAY); // whole days remaining (Req 7.2)

            // In-app + push (Req 7.1)
            await notificationService.createNotification({
                userId: booking.user._id,
                type: 'balance_due_reminder',
                title: 'Balance payment due',
                message: `Your remaining balance of ₹${balanceAmount} is due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Pay now to keep your booking.`,
                data: {
                    referenceId: booking._id,
                    referenceModel: 'Booking',
                    // The booking page carries the "Pay remaining amount" button.
                    actionUrl: `/dashboard/bookings/${booking._id}`
                },
                priority: 'high',
                channel: 'all'
            });

            // Req 7.5: log and continue on email failure
            try {
                await emailService.sendBalanceReminderEmail(booking.user.email, booking.user.name, {
                    venueName: booking.venue.name,
                    daysLeft,
                    balanceAmount,
                    balanceDueAt,
                    bookingId: booking._id
                });
            } catch (e) {
                console.error(`  ❌ Failed to email balance reminder for booking ${booking._id}:`, e.message);
            }

            // Set after the attempt so a hard email failure doesn't suppress the whole batch (Req 7.5).
            await Booking.updateOne(
                { _id: booking._id },
                { $set: { 'paymentSchedule.lastReminderOn': today } }
            );
        }

        await sendDayBeforeReminders(now);

        console.log('✅ Balance reminders job completed');
    } catch (error) {
        console.error('❌ Balance reminders job failed:', error.message);
    }
}

/**
 * One-time final notice on the morning two days before the booking (the 8th for
 * a booking on the 10th), when the balance is still unpaid: pay now or cancel.
 * Claimed atomically on finalNoticeSentAt, so each booking gets exactly one. A
 * booking that is paid by then gets nothing here, and the day-before reminder
 * instead.
 */
async function sendBalanceFinalNotices(now = new Date()) {
    const candidates = await Booking.find({
        'paymentSchedule.type': 'installment',
        'paymentSchedule.balanceStatus': 'pending',
        'paymentSchedule.finalNoticeSentAt': null,
        'paymentSchedule.balanceDueAt': { $gt: now },
        paymentStatus: 'paid',
        status: 'accepted',
        bookingDate: { $lte: new Date(now.getTime() + 3 * MS_PER_DAY) },
    }).select('bookingDate').lean();

    for (const c of candidates) {
        if (daysUntilBookingDay(c.bookingDate, now) > 2) continue;
        const booking = await Booking.findOneAndUpdate(
            { _id: c._id, 'paymentSchedule.finalNoticeSentAt': null, 'paymentSchedule.balanceStatus': 'pending', status: 'accepted' },
            { $set: { 'paymentSchedule.finalNoticeSentAt': now } },
            { new: true }
        ).populate('user', 'name email').populate('venue', 'name');
        if (!booking) continue;

        const { balanceAmount, balanceDueAt } = booking.paymentSchedule;
        const due = formatWhen(balanceDueAt);
        try {
            await notificationService.createNotification({
                userId: booking.user._id,
                type: 'balance_due_reminder',
                title: 'Final notice: pay or cancel',
                message: `Pay the remaining ₹${balanceAmount} for ${booking.venue?.name || 'your booking'} by ${due}, or cancel to get back what the venue's policy allows. Otherwise the booking is cancelled and the deposit is not refunded.`,
                data: { referenceId: booking._id, referenceModel: 'Booking', actionUrl: `/dashboard/bookings/${booking._id}` },
                priority: 'high',
                channel: 'all'
            });
            await emailService.sendBalanceFinalNoticeEmail(booking.user.email, booking.user.name, {
                venueName: booking.venue?.name || 'your venue',
                balanceAmount,
                balanceDueAt,
                bookingId: booking._id,
            });
        } catch (e) {
            console.error(`  ❌ Failed to send final notice for booking ${booking._id}:`, e.message);
        }
    }
}

/**
 * "Your booking is tomorrow", on the morning of the day before, to every
 * accepted booking that is fully paid (paid in full, or advance and balance).
 * Claimed atomically on dayBeforeReminderSentAt, so it goes out once.
 */
async function sendDayBeforeReminders(now = new Date()) {
    const candidates = await Booking.find({
        status: 'accepted',
        paymentStatus: 'paid',
        'paymentSchedule.dayBeforeReminderSentAt': null,
        $or: [{ 'paymentSchedule.type': 'full' }, { 'paymentSchedule.balanceStatus': 'paid' }],
        bookingDate: { $gte: new Date(now.getTime() - MS_PER_DAY), $lte: new Date(now.getTime() + 2 * MS_PER_DAY) },
    }).select('bookingDate').lean();

    for (const c of candidates) {
        if (daysUntilBookingDay(c.bookingDate, now) !== 1) continue;
        const booking = await Booking.findOneAndUpdate(
            { _id: c._id, 'paymentSchedule.dayBeforeReminderSentAt': null, status: 'accepted' },
            { $set: { 'paymentSchedule.dayBeforeReminderSentAt': now } },
            { new: true }
        ).populate('user', 'name email').populate('venue', 'name address');
        if (!booking) continue;

        const venueName = booking.venue?.name || 'your venue';
        const message = `Your booking at ${venueName} is tomorrow, ${booking.startTime} - ${booking.endTime}. It is fully paid - see you there!`;
        try {
            await notificationService.createNotification({
                userId: booking.user._id,
                type: 'event_reminder',
                title: 'Your booking is tomorrow',
                message,
                data: { referenceId: booking._id, referenceModel: 'Booking', actionUrl: `/dashboard/bookings/${booking._id}` },
                priority: 'high',
                channel: 'all'
            });
            await emailService.sendBookingUpdateEmail(booking.user.email, booking.user.name, {
                subject: `Reminder: your booking at ${venueName} is tomorrow`,
                heading: 'See you tomorrow',
                lines: [message],
                bookingId: booking._id,
            });
        } catch (e) {
            console.error(`  ❌ Failed to send day-before reminder for booking ${booking._id}:`, e.message);
        }
    }
}

/**
 * Requests the venue owner never answered. The owner has until
 * ownerResponse.respondBy (48 hours, or 24 hours before the booking if sooner);
 * after that the request is cancelled, the dates released and both sides told.
 * Requests made before respondBy existed fall back to 24 hours before the
 * booking. Anything the guest had paid on one (from before payment moved after
 * acceptance) is raised in full as a refund to be done - it was the venue that
 * did not respond, so nothing is forfeited.
 */
async function expireUnansweredRequests(now = new Date()) {
    const { eventStartAt } = require('../utils/paymentSchedule');
    const refundService = require('../services/refundService');
    const horizon = new Date(now.getTime() + 3 * MS_PER_DAY);
    const candidates = await Booking.find({
        status: 'pending',
        $or: [
            { 'ownerResponse.respondBy': { $lte: now } },
            { 'ownerResponse.respondBy': null, bookingDate: { $lte: horizon } },
        ],
    }).select('bookingDate startTime ownerResponse').lean();

    for (const c of candidates) {
        const cutoff = c.ownerResponse?.respondBy
            ? new Date(c.ownerResponse.respondBy).getTime()
            : eventStartAt(c.bookingDate, c.startTime).getTime() - BALANCE_DUE_HOURS_BEFORE * 3600 * 1000;
        if (cutoff > now.getTime()) continue;

        const booking = await Booking.findOneAndUpdate(
            { _id: c._id, status: 'pending' },
            { $set: { status: 'cancelled', cancellationReason: 'venue_did_not_respond', 'paymentSchedule.balanceStatus': 'not_applicable' } },
            { new: true }
        ).populate('venue', 'name owner');
        if (!booking) continue;

        try {
            const { refunds } = await refundService.raiseBookingRefunds(booking, 100, {
                reasonDetails: `Venue did not respond to booking ${booking._id} in time`,
            });
            const venue = await Venue.findById(booking.venue?._id || booking.venue);
            if (venue) {
                releaseBookingDays(venue, booking);
                await venue.save({ validateModifiedOnly: true });
            }
            const refunded = refunds.reduce((sum, r) => sum + r.amount, 0);
            await notificationService.createNotification({
                userId: booking.user,
                type: 'booking_cancelled',
                title: 'Booking request expired',
                message: `${booking.venue?.name || 'The venue'} did not answer your booking request in time, so it has expired.`
                    + (refunded > 0 ? ` Your payment of ₹${refunded} will be refunded.` : ' Nothing was charged.'),
                data: { referenceId: booking._id, referenceModel: 'Booking', actionUrl: `/dashboard/bookings/${booking._id}` },
                priority: 'high',
                channel: 'all'
            });
            if (booking.venue?.owner) {
                await notificationService.createNotification({
                    userId: booking.venue.owner,
                    type: 'booking_cancelled',
                    title: 'Booking request expired',
                    message: `A booking request for ${booking.venue.name} was not answered in time and has expired.`,
                    data: { referenceId: booking._id, referenceModel: 'Booking', actionUrl: `/venue-portal/bookings/${booking._id}` },
                    priority: 'medium',
                    channel: 'all'
                });
            }
        } catch (e) {
            console.error(`  ❌ Failed to finish expiring booking ${booking._id}:`, e.message);
        }
    }
}

/**
 * Accepted bookings the guest did not pay for by paymentDueAt (plus a short
 * grace for a checkout under way): cancelled, dates released, both sides told.
 * Nothing was paid, so there is nothing to refund. A payment that still lands
 * afterwards is raised for a refund by bookingService.
 */
async function expireUnpaidAcceptedBookings(now = new Date()) {
    const cutoff = new Date(now.getTime() - PAYMENT_GRACE_MS);
    while (true) {
        const booking = await Booking.findOneAndUpdate(
            { status: 'accepted', paymentStatus: { $ne: 'paid' }, paymentDueAt: { $ne: null, $lte: cutoff } },
            { $set: { status: 'cancelled', cancellationReason: 'payment_not_received', 'paymentSchedule.balanceStatus': 'not_applicable' } },
            { new: true }
        ).populate('venue', 'name owner');
        if (!booking) break;

        try {
            const venue = await Venue.findById(booking.venue?._id || booking.venue);
            if (venue) {
                releaseBookingDays(venue, booking);
                await venue.save({ validateModifiedOnly: true });
            }
            const venueName = booking.venue?.name || 'the venue';
            // An event's venue booking: the event is cancelled with it, and the
            // organiser is told about the event rather than a bare booking.
            if (booking.event) {
                await require('../services/eventService').onVenueBookingLapsed(booking);
            }
            if (!booking.event) await notificationService.createNotification({
                userId: booking.user,
                type: 'booking_cancelled',
                title: 'Booking cancelled - not paid',
                message: `Your booking at ${venueName} was not paid for by ${formatWhen(booking.paymentDueAt)}, so it is cancelled and the date is released.`,
                data: { referenceId: booking._id, referenceModel: 'Booking', actionUrl: `/dashboard/bookings/${booking._id}` },
                priority: 'high',
                channel: 'all'
            });
            if (booking.venue?.owner) {
                await notificationService.createNotification({
                    userId: booking.venue.owner,
                    type: 'booking_cancelled',
                    title: 'Booking cancelled - not paid',
                    message: booking.event
                        ? `The organiser did not pay for their event at ${venueName} in time. The event is cancelled and the date is free again.`
                        : `The guest did not pay for their booking at ${venueName} in time. It is cancelled and the date is free again.`,
                    data: { referenceId: booking._id, referenceModel: 'Booking', actionUrl: `/venue-portal/bookings/${booking._id}` },
                    priority: 'medium',
                    channel: 'all'
                });
            }
        } catch (e) {
            console.error(`  ❌ Failed to finish cancelling unpaid booking ${booking._id}:`, e.message);
        }
    }
}

/**
 * Enforce balance-payment deadlines for installment bookings whose 90% balance is
 * still pending at or past its deadline: cancel the booking, forfeit the deposit,
 * release the venue's booked date, and notify the customer (Req 4 & 5).
 *
 * The claim and the state transition are ONE atomic findOneAndUpdate: the selector
 * requires balanceStatus 'pending', and the same $set clears it to 'forfeited'. So
 * a concurrent or subsequent run can never match the same doc — exactly one cancel
 * and one forfeit per booking (Req 5.2, Property 6). We .populate user+venue so the
 * (pre-update) returned doc carries the email/name/venue name for notification.
 *
 * ponytail: mirrors sendBalanceReminders/sendEventReminders — atomic claim loop,
 * side-effects in try/catch that never undo the cancel (Req 5.3), exported for tests.
 */
async function enforceBalanceDeadlines() {
    try {
        const now = new Date();

        while (true) {
            const claimed = await Booking.findOneAndUpdate(
                {
                    'paymentSchedule.type': 'installment',
                    'paymentSchedule.balanceStatus': 'pending',
                    'paymentSchedule.balanceDueAt': { $lte: now },
                    // Only an accepted booking forfeits its deposit. A request the
                    // venue never answered is expired with a full refund instead
                    // (expireUnansweredRequests).
                    status: 'accepted'
                },
                {
                    $set: {
                        status: 'cancelled',
                        'paymentSchedule.balanceStatus': 'forfeited',
                        cancellationReason: 'missed_payment_deadline' // Req 4.1; never touches cancellationPolicy (Req 4.3, Property 4)
                    }
                },
                { new: false } // pre-update doc; its 'pending' claim predicate is what we just cleared → no double-process (Property 6)
            )
                .populate('user', 'name email')
                .populate('venue', 'name');

            if (!claimed) break;

            // Req 4.4: release every day the booking held so others can book them.
            try {
                const venueId = claimed.venue?._id || claimed.venue;
                const venue = await Venue.findById(venueId);
                if (venue) {
                    releaseBookingDays(venue, claimed);
                    await venue.save({ validateModifiedOnly: true });
                }
            } catch (e) {
                console.error(`  ❌ Failed to release venue date for booking ${claimed._id}:`, e.message);
            }

            // Req 4.5: notify the customer (in-app + push + email). Req 5.3: on
            // failure, log only — the cancellation/forfeiture is already committed
            // and must NOT be undone or retried.
            try {
                const depositAmount = claimed.paymentSchedule?.depositAmount;
                await notificationService.createNotification({
                    userId: claimed.user?._id || claimed.user,
                    type: 'booking_forfeited',
                    title: 'Booking cancelled - deposit forfeited',
                    message: `Your booking was cancelled and your ₹${depositAmount} deposit forfeited because the remaining balance was not paid by the deadline.`,
                    data: {
                        referenceId: claimed._id,
                        referenceModel: 'Booking',
                        actionUrl: '/dashboard/bookings'
                    },
                    priority: 'high',
                    channel: 'all'
                });

                await emailService.sendBalanceForfeitEmail(claimed.user?.email, claimed.user?.name, {
                    venueName: claimed.venue?.name,
                    depositAmount,
                    bookingId: claimed._id
                });
            } catch (e) {
                console.error(`  ❌ Failed to notify forfeiture for booking ${claimed._id}:`, e.message);
            }
        }

        await expireUnansweredRequests(now);
        await expireUnpaidAcceptedBookings(now);

        console.log('✅ Balance deadline enforcement job completed');
    } catch (error) {
        console.error('❌ Balance deadline enforcement job failed:', error.message);
    }
}

/**
 * Initialize all scheduled jobs
 */
function initScheduledJobs() {
    // PM2 cluster mode runs one copy of this process per instance (2 in
    // ecosystem.config.js), and every copy used to schedule every job - so each
    // reminder email went out twice and deadline enforcement ran concurrently
    // against the same bookings. PM2 numbers its instances via NODE_APP_INSTANCE;
    // only the first runs the jobs. Outside PM2 it is unset and the jobs run.
    const instance = process.env.NODE_APP_INSTANCE;
    if (instance !== undefined && instance !== '0') {
        console.log(`⏰ Scheduled jobs skipped on instance ${instance} (instance 0 runs them)`);
        return;
    }

    console.log('⏰ Initializing scheduled jobs...');

    // Run event reminders every 10 minutes
    cron.schedule('*/10 * * * *', () => {
        console.log('🔄 Running event reminders job...');
        sendEventReminders();
        syncEventLifecycle();
    });

    // Once on boot as well: without this, every event that ended while the process
    // was down (or before this job existed) stays mislabelled until the next tick.
    syncEventLifecycle();

    // Daily balance-payment reminders at 09:00 server time
    cron.schedule('0 9 * * *', () => {
        console.log('🔄 Running balance reminders job...');
        sendBalanceReminders();
    });

    // Hourly balance-deadline enforcement at :05 of every hour. No on-boot run:
    // that would risk surprising cancellations right at deploy; the next tick is
    // at most an hour away, well within a deadline measured in days.
    cron.schedule('5 * * * *', () => {
        console.log('🔄 Running balance deadline enforcement job...');
        enforceBalanceDeadlines();
    });

    console.log('✅ Scheduled jobs initialized:');
    console.log('   - Event reminders: Every 10 minutes');
    console.log('   - Event lifecycle (ongoing/completed): Every 10 minutes + on boot');
    console.log('   - Balance reminders, final notices, day-before reminders: Daily at 09:00');
    console.log('   - Balance deadlines, expired requests, unpaid bookings: Hourly at :05');
}

module.exports = {
    initScheduledJobs,
    sendEventReminders, // Export for manual testing
    sendBalanceReminders, // Export for manual testing
    enforceBalanceDeadlines, // Export for manual testing
    sendBalanceFinalNotices,
    sendDayBeforeReminders,
    expireUnansweredRequests,
    expireUnpaidAcceptedBookings,
    syncEventLifecycle,
    // Exported so the filters can be checked without a database.
    LIVE_EVENT_STATUSES,
    completedEventFilter,
    ongoingEventFilter,
};

/**
 * Move events through their time-based lifecycle: ongoing while they are running,
 * completed once they have ended.
 *
 * Nothing in the app ever wrote these two statuses. Approval set `approved` and it
 * stayed `approved` forever, so the admin dashboard's Ongoing and Completed filters
 * matched zero documents no matter how many events had finished, and
 * `ticketService`'s "this event is completed" guard could never fire. The fix
 * belongs here rather than in the admin query: every consumer of Event.status was
 * reading a value that was never maintained.
 *
 * Only time-driven states are touched. cancelled / rejected / blocked / draft /
 * pending are terminal or manual decisions and are left alone.
 */
/** Events that have ended and are still labelled as live. */
function completedEventFilter(now) {
    return {
        status: { $in: [...LIVE_EVENT_STATUSES, 'ongoing'] },
        endDateTime: { $lte: now },
        isDeleted: { $ne: true },
    };
}

/** Events that have started but not yet ended. */
function ongoingEventFilter(now) {
    return {
        status: { $in: LIVE_EVENT_STATUSES },
        startDateTime: { $lte: now },
        endDateTime: { $gt: now },
        isDeleted: { $ne: true },
    };
}

async function syncEventLifecycle() {
    try {
        const now = new Date();

        // Ended first, so an event that both started and ended since the last run
        // lands on its final state in one pass.
        const completed = await Event.updateMany(
            completedEventFilter(now),
            { $set: { status: 'completed' } }
        );

        const ongoing = await Event.updateMany(
            ongoingEventFilter(now),
            { $set: { status: 'ongoing' } }
        );

        if (completed.modifiedCount || ongoing.modifiedCount) {
            console.log(`🗓️  Event lifecycle: ${ongoing.modifiedCount} → ongoing, ${completed.modifiedCount} → completed`);
        }
        return { ongoing: ongoing.modifiedCount, completed: completed.modifiedCount };
    } catch (error) {
        console.error('❌ Event lifecycle job failed:', error.message);
        return { ongoing: 0, completed: 0 };
    }
}
