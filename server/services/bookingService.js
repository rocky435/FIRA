const Booking = require('../models/Booking');
const whatsappService = require('./whatsappService');
const whatsappTemplates = require('../utils/whatsappTemplates');
const { roundMoney } = require('../utils/money');
const paymentScheduleUtil = require('../utils/paymentSchedule');

/** Unpaid requests (waiting for the owner, or accepted and not yet paid) one person may have open. */
const MAX_OPEN_REQUESTS = 3;

/**
 * Mark every day `booking` covers as 'booked' on its venue's calendar.
 * Best-effort: the booking itself is already committed, and the Booking-range
 * check in createBooking is what actually prevents a double booking.
 * Calendar saves here and elsewhere validate only what they change, so an older
 * venue missing a since-required field still gets its calendar updated.
 */
async function blockVenueCalendar(booking) {
    try {
        const Venue = require('../models/Venue');
        const { blockBookingDays } = require('../utils/venueAvailability');
        const venue = await Venue.findById(booking.venue?._id || booking.venue);
        if (!venue) return;
        blockBookingDays(venue, booking);
        await venue.save({ validateModifiedOnly: true });
    } catch (err) {
        console.error(`Failed to block calendar for booking ${booking._id}:`, err.message);
    }
}

const formatWhen = (date) => new Date(date).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * The payment schedule the guest gets by paying up front now: 10% advance with
 * the rest due later when they pick 'advance' and the booking is more than 7
 * days away, otherwise the whole amount. The guest chooses once the owner has
 * accepted; an advance is only offered while it is still possible.
 */
function upfrontSchedule(booking, plan, now = new Date()) {
    const installment = paymentScheduleUtil.build(now, booking.bookingDate, booking.startTime, booking.totalAmount);
    return plan === 'full' || installment.type !== 'installment'
        ? paymentScheduleUtil.fullSchedule(booking.totalAmount)
        : installment;
}

/**
 * Which up-front schedule a confirmed payment paid for, from its amount: the
 * whole total, or the 10% advance as it stood when the order was created. Null
 * when it is neither. Shared by verify and the webhook so both agree.
 */
function scheduleForUpfrontPayment(booking, payment) {
    const paid = roundMoney(payment.subtotal);
    const total = roundMoney(booking.totalAmount);
    if (paid === total) return paymentScheduleUtil.fullSchedule(total);
    const ordered = paymentScheduleUtil.build(new Date(payment.createdAt || Date.now()), booking.bookingDate, booking.startTime, total);
    if (ordered.type === 'installment' && paid === ordered.depositAmount) return ordered;
    // A booking from before the guest chose: its deposit was fixed when it was made.
    const s = booking.paymentSchedule || {};
    if (s.type === 'installment' && paid === roundMoney(s.depositAmount)) {
        return { type: 'installment', depositAmount: s.depositAmount, balanceAmount: s.balanceAmount, balanceDueAt: s.balanceDueAt, balanceStatus: 'pending' };
    }
    return null;
}

/**
 * A payment that arrived for a booking that can no longer take it (already paid,
 * cancelled for non-payment, rejected). The money is in, so it goes to "Refunds
 * to be done" for an admin, like every refund - minus fee and GST, as always.
 */
async function refundStrayPayment(booking, payment, why) {
    console.error(`Payment ${payment._id} arrived for booking ${booking._id} but ${why}; raising a refund`);
    try {
        const refundService = require('./refundService');
        await refundService.processRefund(payment._id, {
            amount: roundMoney(payment.subtotal) || undefined,
            reason: 'booking_cancelled',
            reasonDetails: `Payment for booking ${booking._id} arrived after ${why}`,
            userId: booking.user,
        });
    } catch (err) {
        // Already raised (verify and the webhook both got here) or not refundable.
        console.error(`Could not raise refund for payment ${payment._id}: ${err.message}`);
    }
}

/**
 * Record a confirmed up-front payment (advance or whole amount) on its booking,
 * with the schedule it paid for. Idempotent: the client's verify call and the
 * Razorpay webhook can both get here for the same payment.
 *
 * The write is conditional on the booking still being open and unpaid, so a
 * payment landing just as the booking was cancelled for non-payment cannot
 * revive it; that payment is raised for a refund instead, as is a second
 * payment for a booking that was already paid.
 *
 * @returns {Promise<{ applied: boolean, booking: any }>}
 */
async function applyAdvancePaid(booking, payment, schedule) {
    if (booking.paymentStatus === 'paid' && String(booking.payment) === String(payment._id)) {
        return { applied: false, booking };
    }
    const update = { paymentStatus: 'paid', payment: payment._id, paymentDueAt: null };
    if (schedule) {
        update.paymentSchedule = { ...schedule, balancePayment: null, lastReminderOn: null, finalNoticeSentAt: null, dayBeforeReminderSentAt: null };
    }
    const updated = await Booking.findOneAndUpdate(
        { _id: booking._id, paymentStatus: { $ne: 'paid' }, status: { $in: ['pending', 'accepted'] } },
        { $set: update },
        { new: true }
    );
    if (!updated) {
        const fresh = await Booking.findById(booking._id);
        if (fresh && fresh.paymentStatus === 'paid' && String(fresh.payment) === String(payment._id)) {
            return { applied: false, booking: fresh };
        }
        await refundStrayPayment(booking, payment, fresh?.paymentStatus === 'paid' ? 'it was already paid' : `it was ${fresh?.status || 'removed'}`);
        return { applied: false, booking: fresh || booking };
    }

    // A paid booking holds its dates on the venue calendar (idempotent).
    await blockVenueCalendar(updated);

    // The venue booking of an event: paying it is what lets the event go live.
    if (updated.event) {
        try {
            await require('./eventService').onVenueBookingPaid(updated);
        } catch (err) {
            console.error(`Could not publish event ${updated.event} after its venue was paid:`, err.message);
        }
    }

    try {
        const Venue = require('../models/Venue');
        const notificationService = require('./notificationService');
        const venue = await Venue.findById(updated.venue).select('owner name').lean();
        if (venue) {
            const when = new Date(updated.bookingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
            const s = updated.paymentSchedule || {};
            const what = s.type === 'installment' ? `the ₹${s.depositAmount} advance` : `the full ₹${updated.totalAmount}`;
            const accepted = updated.status === 'accepted';
            notificationService.createNotification({
                userId: venue.owner,
                type: accepted ? 'payment_success' : 'booking_request',
                title: accepted ? 'Booking confirmed - guest paid' : 'New booking request - advance paid',
                message: accepted
                    ? `The guest paid ${what} for ${venue.name} on ${when}. The booking is confirmed.`
                    : `A guest paid the advance for ${venue.name} on ${when}. Accept or reject the request.`,
                data: { referenceId: updated._id, referenceModel: 'Booking', actionUrl: `/venue-portal/bookings/${updated._id}` },
                priority: 'high',
                channel: 'all'
            }).catch(err => console.error('Owner payment notification failed:', err.message));
        }
    } catch (err) {
        console.error('Owner notification failed:', err.message);
    }
    return { applied: true, booking: updated };
}

/**
 * Record a confirmed balance payment on its booking. Idempotent, like
 * applyAdvancePaid.
 *
 * Conditional on the balance still being pending, the booking still accepted and
 * the deadline not passed, so a race with the enforcement job can't revive a
 * forfeited booking. A balance that arrives too late is raised for a refund.
 */
async function applyBalancePaid(booking, payment) {
    const s = booking.paymentSchedule || {};
    if (s.balanceStatus === 'paid' && String(s.balancePayment) === String(payment._id)) {
        return { applied: false };
    }
    const updated = await Booking.findOneAndUpdate(
        {
            _id: booking._id,
            status: 'accepted',
            // A balance only counts once the advance confirmed the booking.
            paymentStatus: 'paid',
            'paymentSchedule.balanceStatus': 'pending',
            $or: [{ 'paymentSchedule.balanceDueAt': null }, { 'paymentSchedule.balanceDueAt': { $gt: new Date() } }],
        },
        { $set: { 'paymentSchedule.balanceStatus': 'paid', 'paymentSchedule.balancePayment': payment._id } },
        { new: true }
    );
    if (updated) {
        booking.paymentSchedule.balanceStatus = 'paid';
        booking.paymentSchedule.balancePayment = payment._id;
        return { applied: true };
    }
    const fresh = await Booking.findById(booking._id).lean();
    if (String(fresh?.paymentSchedule?.balancePayment) === String(payment._id)) return { applied: false };
    await refundStrayPayment(booking, payment, `the balance was ${fresh?.paymentSchedule?.balanceStatus || 'not due'}`);
    return { applied: false, note: 'balance not applied; raised for a refund' };
}

/** What the guest is told when the owner accepts: what to pay, and by when. */
function acceptedMessage(booking, venueName) {
    const when = new Date(booking.bookingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    if (booking.paymentStatus !== 'paid') {
        const s = booking.paymentSchedule || {};
        const options = s.type === 'installment'
            ? `the 10% advance (₹${s.depositAmount}) or the full ₹${booking.totalAmount}`
            : `₹${booking.totalAmount}`;
        const due = booking.paymentDueAt ? ` by ${formatWhen(booking.paymentDueAt)}` : '';
        return `${venueName} accepted your booking request for ${when}. Pay ${options} in the app${due} to confirm it.`;
    }
    const s = booking.paymentSchedule || {};
    if (s.type === 'installment' && s.balanceStatus === 'pending') {
        const due = s.balanceDueAt ? formatWhen(s.balanceDueAt) : 'the deadline';
        return `${venueName} accepted your booking for ${when}. Pay the remaining ₹${s.balanceAmount} in the app by ${due} to keep it.`;
    }
    return `${venueName} accepted your booking for ${when}.`;
}

const bookingService = {
    // Get all bookings
    async getAllBookings(query = {}) {
        const { page = 1, limit = 10, status, user, venue } = query;
        const filter = {};
        if (status) filter.status = String(status);
        if (user) filter.user = String(user);
        if (venue) filter.venue = String(venue);

        const bookings = await Booking.find(filter)
            .populate('user', 'name email')
            .populate('venue', 'name address')
            .limit(limit * 1)
            .skip((page - 1) * limit)
            .sort({ createdAt: -1 })
            .lean();

        const total = await Booking.countDocuments(filter);

        return {
            bookings,
            totalPages: Math.ceil(total / limit),
            currentPage: page,
            total
        };
    },

    // Get user's bookings
    async getUserBookings(userId) {
        const bookings = await Booking.find({ user: userId })
            .populate('venue', 'name address images')
            .sort({ bookingDate: -1 })
            .lean();
        return bookings;
    },

    // Get venue's bookings
    async getVenueBookings(venueId) {
        const bookings = await Booking.find({ venue: venueId })
            .populate('user', 'name email phone')
            // The owner's booking lists show which venue each row is for.
            .populate('venue', 'name images')
            .sort({ bookingDate: -1 })
            .lean();
        return bookings;
    },

    // Get booking by ID
    async getBookingById(id) {
        const booking = await Booking.findById(id)
            .populate('user', 'name email phone')
            // platformFeePercentage: the booking page shows the same fee + GST the
            // checkout will charge, before the guest opens it.
            .populate('venue', 'name address images pricing platformFeePercentage')
            // The event this venue booking is for, so its page can say so.
            .populate('event', 'name status');
        if (!booking) {
            throw new Error('Booking not found');
        }
        return booking;
    },

    // Create booking
    async createBooking(data) {
        const Venue = require('../models/Venue');
        const User = require('../models/User');
        const emailService = require('./emailService');
        const paymentSchedule = require('../utils/paymentSchedule');

        // Only a live listing can be booked: approved by admin, active, not
        // deleted. Nothing checked this, so a pending, rejected, suspended or
        // deleted venue could still be booked through the API.
        const { isVenueBookable } = require('../utils/venueAvailability');
        const target = require('mongoose').isValidObjectId(data.venue)
            ? await Venue.findById(data.venue).select('status isActive isDeleted owner').lean()
            : null;
        if (!isVenueBookable(target)) {
            throw new Error('This venue is not available for booking');
        }

        // An owner booking their own venue would pay themselves (plus fees), and
        // as the guest they could not then accept it. Their own dates are
        // blocked from the venue's availability instead.
        if (target.owner && String(target.owner) === String(data.user)) {
            throw new Error('This is your own venue. To keep dates free, block them from your venue dashboard instead of booking.');
        }

        // Requests cost nothing and hold their dates while the owner decides, so
        // one person could otherwise block a venue's best dates over and over.
        // A few open, unpaid requests at a time is plenty for a real guest.
        const openRequests = await Booking.countDocuments({
            user: data.user,
            event: null, // not the booking an approved event holds on its venue
            status: { $in: ['pending', 'accepted'] },
            paymentStatus: { $ne: 'paid' },
        });
        if (openRequests >= MAX_OPEN_REQUESTS) {
            throw new Error(`You already have ${MAX_OPEN_REQUESTS} booking requests waiting. Pay for or cancel one before sending another.`);
        }

        // A same-day booking with startTime >= endTime is zero-duration (or
        // inverted) - nothing on the client enforced this, so a booking naming
        // e.g. 14:00-14:00 could reach here and be "confirmed" as valid. Only
        // rejected when start and end fall on the same calendar day: a multi-day
        // booking's end time is a different day, so any end time is legitimate.
        if (data.bookingDate && data.startTime && data.endTime) {
            const bookingDay = new Date(data.bookingDate).toISOString().split('T')[0];
            const endDay = data.endDate
                ? new Date(data.endDate).toISOString().split('T')[0]
                : bookingDay;
            if (endDay < bookingDay) {
                throw new Error('End date must be on or after the start date');
            }
            if (endDay === bookingDay && data.endTime <= data.startTime) {
                throw new Error('End time must be after start time');
            }
        }

        // A client must not be able to create a booking that is already
        // accepted/paid, or carries its own schedule - those are server decisions.
        data.status = 'pending';
        delete data.paymentStatus;
        delete data.payment;
        delete data.paymentSchedule;
        delete data.paymentDueAt;
        delete data.ownerResponse;
        delete data.platformFee;
        if (!data.endDate) data.endDate = null;

        // Booking here is day-rate, not per-slot (see venuePricing.js), so any
        // other non-terminal booking that touches ANY day of this one's range
        // blocks it - regardless of the times either one names. Only the start
        // day used to be checked, so a 21st-22nd request sailed past a booking
        // that already held the 22nd.
        if (data.venue && data.bookingDate) {
            const {
                bookingDayKeys, isDayTaken, overlappingBookingFilter, MAX_BOOKING_DAYS,
            } = require('../utils/venueAvailability');

            const dayKeys = bookingDayKeys(data.bookingDate, data.endDate);
            if (dayKeys.length === 0) {
                throw new Error('End date must be on or after the start date');
            }
            const startKey = dayKeys[0];
            const endKey = data.endDate
                ? new Date(data.endDate).toISOString().split('T')[0]
                : startKey;
            if (endKey !== dayKeys[dayKeys.length - 1]) {
                throw new Error(`A booking can cover at most ${MAX_BOOKING_DAYS} days`);
            }

            const unavailable = dayKeys.length > 1
                ? 'One or more of the selected dates is no longer available for this venue'
                : 'This date is no longer available for this venue';

            const todayKey = new Date().toISOString().split('T')[0];
            if (startKey < todayKey) {
                throw new Error('Bookings cannot start in the past');
            }

            const existing = await Booking.findOne(overlappingBookingFilter(data.venue, startKey, endKey));
            if (existing) {
                throw new Error(unavailable);
            }

            // Calendar blocks: owner 'busy' days (offline/external bookings) and
            // system 'booked' days (events, confirmed bookings). Without this the
            // UI showed the day as unavailable but a direct submit still went in.
            const venueDoc = await Venue.findById(data.venue).select('blockedDates daySlots pricing');
            const bookedDaySlot = new Set(
                (venueDoc?.daySlots || [])
                    .filter(s => s.isBooked)
                    .map(s => new Date(s.date).toISOString().split('T')[0])
            );
            if (dayKeys.some(k => isDayTaken(venueDoc?.blockedDates, k) || bookedDaySlot.has(k))) {
                throw new Error(unavailable);
            }

            // The amount is priced here, never taken from the request: each day
            // at its rate (special date, weekend or day rate), the same rule the
            // client shows (venuePricing.ts). A venue with no price cannot be
            // booked - the client's total used to be trusted for one.
            const { bookingTotal, baseDayRate } = require('../utils/venuePricing');
            if (!(baseDayRate(venueDoc) > 0)) {
                throw new Error('This venue has no price set yet, so it cannot be booked');
            }
            data.totalAmount = bookingTotal(venueDoc, dayKeys);
        } else {
            throw new Error('Choose a date to book');
        }

        // A booking starts as a request: nothing is paid until the owner accepts.
        // The schedule here only previews the options (> 7 days out ⇒ 10%
        // advance, rest due 24h before; otherwise the full amount); it is
        // refreshed on acceptance and fixed by what the guest actually pays.
        const now = new Date();
        data.paymentSchedule = paymentSchedule.build(now, data.bookingDate, data.startTime, data.totalAmount);
        data.ownerResponse = { respondBy: paymentSchedule.stepDeadline(now, data.bookingDate, data.startTime) };

        console.log('📝 Creating booking for venue:', data.venue);
        let booking;
        try {
            booking = await Booking.create(data);
        } catch (err) {
            // The unique {venue, bookingDate} index is the race backstop for the
            // check above; surface it as the same availability error.
            if (err && err.code === 11000) {
                throw new Error('This date is no longer available for this venue');
            }
            throw err;
        }
        console.log('✅ Booking created:', booking._id);

        // Fetch venue with owner details
        const venue = await Venue.findById(data.venue).populate('owner', 'name email');
        console.log('🏢 Venue found:', venue ? venue.name : 'NOT FOUND');
        console.log('👤 Venue owner:', venue?.owner ? `${venue.owner.name} (${venue.owner.email})` : 'NOT FOUND/POPULATED');

        // Function scope, not inside the `if (venue)` block below.
        //
        // This was declared inside that block while the owner-notification block after
        // it also reads `booker.name` - so every booking with a venue owner threw
        // "ReferenceError: booker is not defined". It threw *after* Booking.create, so
        // the booking was saved and the caller still got a 500: the user saw an error
        // for a booking that had actually gone through.
        const booker = await User.findById(data.user).select('name email phone');
        console.log('🎫 Booker:', booker ? `${booker.name} (${booker.email})` : 'NOT FOUND');

        if (venue) {
            // Check if venue has auto-approve enabled
            // Auto-accepted, so the guest's time to pay starts now.
            if (venue.autoApproveBookings) {
                const paymentDueAt = paymentSchedule.stepDeadline(new Date(), booking.bookingDate, booking.startTime);
                await Booking.findByIdAndUpdate(
                    booking._id,
                    { $set: { status: 'accepted', paymentDueAt, 'ownerResponse.respondedAt': new Date() } },
                    { new: true }
                );
                booking.status = 'accepted';
                booking.paymentDueAt = paymentDueAt;
                await blockVenueCalendar(booking);
            }

            // Send WhatsApp confirmation to booker if phone is available
            if (booker?.phone) {
                try {
                    const template = whatsappTemplates.appointment_confirmation_1({
                        userName: booker.name,
                        businessName: 'Fira',
                        venueName: venue.name,
                        date: new Date(data.bookingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                        time: `${data.startTime} - ${data.endTime}`
                    });
                    await whatsappService.sendTemplate({ to: booker.phone, template });
                    console.log('✅ WhatsApp booking confirmation sent to', booker.phone);
                } catch (waErr) {
                    console.warn('⚠️ Failed to send WhatsApp booking confirmation:', waErr.message);
                }
            }

            // Send email notification to venue owner
            if (venue.owner && venue.owner.email && booker) {
                console.log('📧 Attempting to send email to venue owner:', venue.owner.email);
                try {
                    await emailService.sendVenueBookingEmail(
                        venue.owner.email,
                        venue.owner.name || 'Venue Owner',
                        { name: venue.name },
                        {
                            date: data.bookingDate,
                            startTime: data.startTime,
                            endTime: data.endTime,
                            guestCount: data.expectedGuests,
                            totalPrice: data.totalAmount,
                            message: data.specialRequests
                        },
                        {
                            name: booker.name,
                            email: booker.email,
                            phone: booker.phone
                        }
                    );
                    console.log('✅ Venue booking notification sent successfully to:', venue.owner.email);
                } catch (emailErr) {
                    console.error('❌ Failed to send booking notification email:', emailErr.message);
                    console.error('Email error details:', emailErr);
                }
            } else {
                console.log('⚠️ Skipping email - missing data:', {
                    hasOwner: !!venue.owner,
                    hasOwnerEmail: !!venue.owner?.email,
                    hasBooker: !!booker
                });
            }
        } else {
            console.log('⚠️ No venue found, skipping email notification');
        }

        // In-app + push for the venue owner. Email already goes out above, but
        // an owner who lives in the dashboard should not have to check mail.
        if (venue?.owner?._id) {
            const notificationService = require('./notificationService');
            notificationService.createNotification({
                userId: venue.owner._id,
                type: 'booking_request',
                title: 'New booking request',
                message: `${booker?.name || 'Someone'} wants to book ${venue.name} on ${new Date(data.bookingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}.`,
                data: {
                    referenceId: booking._id,
                    referenceModel: 'Booking',
                    actionUrl: '/dashboard/requests',
                    extra: { venueName: venue.name, bookingDate: data.bookingDate }
                },
                priority: 'high',
                channel: 'all'
            }).catch(err => console.error('booking_request notification failed:', err.message));
        }

        return booking;
    },

    // Update booking
    async updateBooking(id, updateData) {
        const booking = await Booking.findByIdAndUpdate(
            id,
            { $set: updateData },
            { new: true }
        );
        if (!booking) {
            throw new Error('Booking not found');
        }
        return booking;
    },

    // Update booking status (accept/reject)
    async updateBookingStatus(id, { status, rejectionReason, modifiedDates }) {
        const updateData = {
            status,
            'ownerResponse.respondedAt': new Date()
        };

        // The owner answers the request before anything is paid. Accepting
        // holds the dates and gives the guest a window to pay the advance or
        // the whole amount; the payment options are worked out afresh now.
        if (status === 'accepted') {
            const current = await Booking.findById(id).select('paymentStatus bookingDate startTime totalAmount').lean();
            if (!current) throw new Error('Booking not found');
            if (current.paymentStatus !== 'paid') {
                const now = new Date();
                updateData.paymentDueAt = paymentScheduleUtil.stepDeadline(now, current.bookingDate, current.startTime);
                updateData.paymentSchedule = paymentScheduleUtil.build(now, current.bookingDate, current.startTime, current.totalAmount);
            }
        }

        // Only a booking that was fully paid and has started can be marked
        // completed. A completed booking is what lets its guest review the
        // venue, so an owner could otherwise accept an unpaid request from a
        // second account, complete it at once and post their own 5 stars.
        if (status === 'completed') {
            const current = await Booking.findById(id).select('paymentStatus paymentSchedule bookingDate startTime').lean();
            if (!current) throw new Error('Booking not found');
            const s = current.paymentSchedule || {};
            const fullyPaid = current.paymentStatus === 'paid' && (s.type !== 'installment' || s.balanceStatus === 'paid');
            if (!fullyPaid) {
                throw new Error('Only a fully paid booking can be marked completed');
            }
            if (paymentScheduleUtil.eventStartAt(current.bookingDate, current.startTime).getTime() > Date.now()) {
                throw new Error('A booking can be marked completed once it has started');
            }
        }

        if (rejectionReason) {
            updateData.rejectionReason = rejectionReason;
        }

        if (modifiedDates) {
            updateData['ownerResponse.modifiedDates'] = modifiedDates;
        }

        // Conditional on the status it is moving from, so an accept racing a
        // guest's cancellation (or a second click) cannot both apply.
        const fromStatus = status === 'completed' ? 'accepted' : 'pending';
        const booking = await Booking.findOneAndUpdate(
            { _id: id, status: fromStatus },
            { $set: updateData },
            { new: true }
        ).populate('venue');

        if (!booking) {
            throw new Error('This booking has already been updated');
        }

        // Rejecting a request the guest already paid for refunds everything they
        // paid (not the platform fee or GST), raised in "Refunds to be done", and
        // frees the dates the request was holding.
        let rejectionRefund = 0;
        if (status === 'rejected') {
            const refundService = require('./refundService');
            const { refunds } = await refundService.raiseBookingRefunds(booking, 100, {
                reasonDetails: `Venue owner rejected booking ${booking._id}${rejectionReason ? `: ${rejectionReason}` : ''}`,
            });
            rejectionRefund = roundMoney(refunds.reduce((sum, r) => sum + r.amount, 0));
            try {
                const Venue = require('../models/Venue');
                const { releaseBookingDays } = require('../utils/venueAvailability');
                const venueDoc = await Venue.findById(booking.venue?._id || booking.venue);
                if (venueDoc) {
                    releaseBookingDays(venueDoc, booking);
                    await venueDoc.save({ validateModifiedOnly: true });
                }
            } catch (err) {
                console.error(`Failed to release calendar for booking ${booking._id}:`, err.message);
            }
        }

        // If accepted, mark every day the booking covers as booked on the
        // venue calendar.
        if (status === 'accepted' && booking.venue) {
            await blockVenueCalendar(booking);
        }

        // Tell the person who made the request what the owner decided.
        if (status === 'accepted' || status === 'rejected') {
            const notificationService = require('./notificationService');
            const venueName = booking.venue?.name || 'the venue';
            const accepted = status === 'accepted';
            const awaitingPayment = accepted && booking.paymentStatus !== 'paid';

            // The in-app notice does not email; a guest who has to pay within
            // a deadline gets it by email too.
            if (awaitingPayment) {
                const User = require('../models/User');
                const emailService = require('./emailService');
                User.findById(booking.user).select('name email').lean()
                    .then(guest => guest && emailService.sendBookingUpdateEmail(guest.email, guest.name, {
                        subject: `${venueName} accepted your booking - pay to confirm`,
                        heading: 'Your booking request was accepted',
                        lines: [acceptedMessage(booking, venueName), 'If it is not paid by then, the booking is cancelled and the date is released.'],
                        bookingId: booking._id,
                        linkText: 'Pay now',
                    }))
                    .catch(err => console.error('Acceptance email failed:', err.message));
            }

            notificationService.createNotification({
                userId: booking.user,
                type: accepted ? 'booking_accepted' : 'booking_rejected',
                title: awaitingPayment ? 'Booking accepted - pay to confirm' : accepted ? 'Booking confirmed 🎉' : 'Booking declined',
                message: accepted
                    ? acceptedMessage(booking, venueName)
                    : `${venueName} could not take your booking${rejectionReason ? `: ${rejectionReason}` : '.'}`
                        + (rejectionRefund > 0 ? ` Your payment of ₹${rejectionRefund} will be refunded.` : ''),
                data: {
                    referenceId: booking._id,
                    referenceModel: 'Booking',
                    actionUrl: `/dashboard/bookings/${booking._id}`,
                    extra: { venueName, status, rejectionReason: rejectionReason || null }
                },
                priority: 'high',
                channel: 'all'
            }).catch(err => console.error(`booking_${status} notification failed:`, err.message));
        }

        return booking;
    },

    // Cancel booking with refund processing. One implementation: the venue's
    // cancellation policy, refunds raised for admin approval, dates released.
    async cancelBooking(id, userId) {
        const venueService = require('./venueService');
        return venueService.processCancellation(id, userId);
    },

    // Initiate payment for an accepted booking. `plan` is the guest's choice:
    // 'advance' (10% now, the rest before the booking - only more than 7 days
    // out) or 'full'. Defaults to the advance where it is offered.
    async initiateBookingPayment(bookingId, userId, { plan } = {}) {
        const paymentService = require('./paymentService');

        const booking = await Booking.findById(bookingId)
            .populate('venue', 'name platformFeePercentage');

        if (!booking) {
            throw new Error('Booking not found');
        }

        if (booking.user.toString() !== userId.toString()) {
            throw new Error('Unauthorized: This booking belongs to another user');
        }

        // Payment follows the owner's acceptance; a request is not paid for.
        if (booking.status === 'pending') {
            throw new Error('The venue has not accepted this booking yet');
        }
        if (booking.status !== 'accepted') {
            throw new Error('This booking can no longer be paid for');
        }

        if (booking.paymentStatus === 'paid') {
            throw new Error('Advance already paid');
        }

        if (booking.paymentDueAt && Date.now() > new Date(booking.paymentDueAt).getTime()) {
            throw new Error('The time to pay for this booking has passed');
        }

        // Charge what the chosen plan takes up front: the 10% advance or the
        // whole total. Route it through the single money source (calculateBilling)
        // so it is charged and recorded with a full breakdown: subtotal, qty 1.
        // Fail closed — if billing throws, we abort before any Razorpay order.
        // An event's venue is paid in full up front: the event goes live on it.
        const schedule = upfrontSchedule(booking, plan === 'full' || booking.event ? 'full' : 'advance');
        const chargeSubtotal = roundMoney(schedule.depositAmount);
        const feePct = booking.venue?.platformFeePercentage ?? 5; // config, not hardcoded
        const billing = paymentService.calculateBilling(chargeSubtotal, 1, feePct);

        // Initiate payment via Razorpay for the ADVANCE billing breakdown.
        const paymentData = await paymentService.initiatePayment({
            userId,
            type: 'venue_booking',
            referenceId: bookingId,
            referenceModel: 'Booking',
            amount: billing.totalAmount,
            subtotal: billing.subtotal,
            platformFee: billing.platformFee,
            platformFeePercentage: feePct,
            gstAmount: billing.gstAmount,
            totalAmount: billing.totalAmount
        });

        // Update booking with the platform fee that was actually charged.
        booking.platformFee = billing.platformFee;
        await booking.save();

        return {
            ...paymentData,
            booking: {
                _id: booking._id,
                venueName: booking.venue?.name,
                totalAmount: booking.totalAmount,
                paymentScheduleType: schedule.type,
                depositAmount: schedule.depositAmount,
                balanceAmount: schedule.balanceAmount,
                balanceDueAt: schedule.balanceDueAt,
                advanceAmount: chargeSubtotal, // backward compat: amount charged now
                remainingAmount: roundMoney(booking.totalAmount - chargeSubtotal),
                bookingDate: booking.bookingDate
            }
        };
    },

    // Complete payment after Razorpay verification
    async completeBookingPayment(bookingId, { gatewayOrderId, gatewayPaymentId, gatewaySignature }) {
        const paymentService = require('./paymentService');
        const Payment = require('../models/Payment');

        const booking = await Booking.findById(bookingId);
        if (!booking) {
            throw new Error('Booking not found');
        }

        // Find the payment record for the order that was actually paid. Looking up
        // "any pending payment on this booking" picked an arbitrary one when the
        // guest had started checkout more than once. 'success' is included so a
        // verify that arrives after the webhook already confirmed it still succeeds.
        const payment = typeof gatewayOrderId === 'string' && await Payment.findOne({
            gatewayOrderId,
            referenceId: bookingId,
            referenceModel: 'Booking',
            status: { $in: ['pending', 'failed', 'success'] }
        });

        if (!payment) {
            throw new Error('Payment record not found');
        }

        // The order must be for the advance or the whole amount, not some other
        // charge on it (a balance order, say).
        const schedule = scheduleForUpfrontPayment(booking, payment);
        if (!schedule) {
            throw new Error('This payment is not for the booking advance');
        }

        // Verify payment with Razorpay
        const result = await paymentService.verifyPayment({
            paymentId: payment._id,
            gatewayOrderId,
            gatewayPaymentId,
            gatewaySignature
        });

        if (result.success) {
            const applied = await applyAdvancePaid(booking, result.payment, schedule);
            return { success: true, booking: applied.booking, payment: result.payment };
        }

        throw new Error('Payment verification failed');
    },

    // Initiate payment for the outstanding balance of an installment booking.
    // Mirrors initiateBookingPayment, but charges exactly the frozen
    // balanceAmount (Req 3.4 — no partials; the amount comes from the booking,
    // never from the client).
    async initiateBalancePayment(bookingId, userId) {
        const paymentService = require('./paymentService');

        const booking = await Booking.findById(bookingId)
            .populate('venue', 'name platformFeePercentage');

        if (!booking) {
            throw new Error('Booking not found');
        }

        if (booking.user.toString() !== userId.toString()) {
            throw new Error('Unauthorized: This booking belongs to another user');
        }

        // Only an installment booking with a still-pending balance can be paid
        // (Req 3.3). Anything else — full schedule, already paid, or forfeited —
        // has no balance due.
        const s = booking.paymentSchedule || {};
        if (s.type !== 'installment' || s.balanceStatus !== 'pending') {
            throw new Error('No balance payment is currently due');
        }
        // The rest is paid once the venue has accepted the request.
        if (booking.status !== 'accepted') {
            throw new Error('The venue has not accepted this booking yet');
        }
        // ...and once the advance has confirmed it. The schedule names the balance
        // from the moment the request is made, so it alone does not say it is due.
        if (booking.paymentStatus !== 'paid') {
            throw new Error('Pay the advance first - the rest is due after that');
        }

        // Charge exactly the balance, routed through the single money source so it
        // is recorded with a full breakdown (subtotal, qty 1). Fail closed — if
        // billing throws, we abort before any Razorpay order.
        const chargeSubtotal = roundMoney(s.balanceAmount);
        const feePct = booking.venue?.platformFeePercentage ?? 5;
        const billing = paymentService.calculateBilling(chargeSubtotal, 1, feePct);

        const paymentData = await paymentService.initiatePayment({
            userId,
            type: 'venue_booking',
            referenceId: bookingId,
            referenceModel: 'Booking',
            amount: billing.totalAmount,
            subtotal: billing.subtotal,
            platformFee: billing.platformFee,
            platformFeePercentage: feePct,
            gstAmount: billing.gstAmount,
            totalAmount: billing.totalAmount
        });

        return {
            ...paymentData,
            booking: {
                _id: booking._id,
                venueName: booking.venue?.name,
                balanceAmount: s.balanceAmount,
                balanceDueAt: s.balanceDueAt,
                bookingDate: booking.bookingDate
            }
        };
    },

    // Complete a balance payment after Razorpay verification. Mirrors
    // completeBookingPayment.
    async completeBalancePayment(bookingId, { gatewayOrderId, gatewayPaymentId, gatewaySignature }) {
        const paymentService = require('./paymentService');
        const Payment = require('../models/Payment');

        const booking = await Booking.findById(bookingId);
        if (!booking) {
            throw new Error('Booking not found');
        }

        // Find the payment record for the order that was actually paid ('success'
        // too, for a verify that arrives after the webhook confirmed it).
        const payment = typeof gatewayOrderId === 'string' && await Payment.findOne({
            gatewayOrderId,
            referenceId: bookingId,
            referenceModel: 'Booking',
            status: { $in: ['pending', 'failed', 'success'] }
        });

        if (!payment) {
            throw new Error('Payment record not found');
        }

        // It must be a balance-sized charge. Otherwise a stale, unpaid advance order
        // (10%) could be paid now and submitted here to mark the 90% balance paid.
        const s0 = booking.paymentSchedule || {};
        if (s0.type !== 'installment' || roundMoney(payment.subtotal) !== roundMoney(s0.balanceAmount)) {
            throw new Error('This payment is not for the booking balance');
        }

        const result = await paymentService.verifyPayment({
            paymentId: payment._id,
            gatewayOrderId,
            gatewayPaymentId,
            gatewaySignature
        });

        if (result.success) {
            const { note } = await applyBalancePaid(booking, result.payment);
            return note
                ? { success: true, booking, payment: result.payment, note }
                : { success: true, booking, payment: result.payment };
        }

        throw new Error('Payment verification failed');
    },

    /**
     * Apply a payment the gateway has confirmed (Razorpay webhook) to its booking,
     * for when the guest's app never came back to call verify. Works out from the
     * amount whether it was the advance or the balance. Idempotent.
     */
    async fulfilConfirmedPayment(payment) {
        const booking = await Booking.findById(payment.referenceId);
        if (!booking) {
            console.error(`Confirmed payment ${payment._id} references missing booking ${payment.referenceId}`);
            return { applied: false };
        }
        const paid = roundMoney(payment.subtotal);
        const s = booking.paymentSchedule || {};
        if (booking.paymentStatus === 'paid' && String(booking.payment) === String(payment._id)) {
            return { applied: false };
        }
        if (s.type === 'installment' && paid === roundMoney(s.balanceAmount) && booking.paymentStatus === 'paid') {
            return applyBalancePaid(booking, payment);
        }
        const schedule = scheduleForUpfrontPayment(booking, payment);
        if (schedule || booking.paymentStatus === 'paid') {
            // A second up-front payment on a paid booking is raised for a refund there.
            return applyAdvancePaid(booking, payment, schedule);
        }
        console.error(`Confirmed payment ${payment._id} (Rs ${paid}) matches no charge on booking ${booking._id}; needs manual handling`);
        return { applied: false };
    }
};

module.exports = bookingService;

