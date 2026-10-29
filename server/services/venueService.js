const Venue = require('../models/Venue');
const { normalisePricing } = require('../utils/venuePricing');
const Booking = require('../models/Booking');
const VenueReview = require('../models/VenueReview');
const { citySlug } = require('../utils/citySlug');
const { escapeRegex } = require('../utils/escapeRegex');
const { roundMoney } = require('../utils/money');
const { stripProtected } = require('../utils/stripProtected');

const DEFAULT_CANCELLATION_POLICY = {
    freeCancellationHours: 48,
    partialRefundPercentage: 50,
    noCancellationHours: 24
};

const venueService = {
    // Get all venues
    async getAllVenues(query = {}) {
        const { page = 1, limit = 10, status, city, sort, search, owner, venueType, minCapacity, maxCapacity, minPrice, maxPrice } = query;
        const filter = { isDeleted: { $ne: true } }; // Always exclude deleted venues

        // If querying by owner (dashboard), allow all statuses but exclude deleted
        // Otherwise, only show approved and active venues (public listing)
        if (owner) {
            filter.owner = owner;
            if (status) filter.status = status;
        } else {
            // Public listing - only approved and active venues
            filter.status = status || 'approved';
            filter.isActive = true;
        }

        // Matched on the canonical slug, not the display name. This used to be an
        // unanchored RegExp(city, 'i'), which had two faults: "Goa" also matched
        // "North Goa" (and "Kota" matched "Kotagiri"), and the caller's string went
        // into a regex unescaped, so a crafted city was a ReDoS lever on a public
        // endpoint. An indexed equality match has neither problem, and it survives
        // the geocoder spelling a city differently next month.
        if (city && city !== 'All') filter['address.citySlug'] = citySlug(city);


        // Venue type filter
        if (venueType && venueType !== 'all') {
            filter.venueType = venueType;
        }

        // Capacity range filter
        if (minCapacity || maxCapacity) {
            filter['capacity.max'] = {};
            if (minCapacity) filter['capacity.max'].$gte = parseInt(minCapacity);
            if (maxCapacity) filter['capacity.max'].$lte = parseInt(maxCapacity);
        }

        // Price range filter
        if (minPrice || maxPrice) {
            filter['pricing.basePrice'] = {};
            if (minPrice) filter['pricing.basePrice'].$gte = parseInt(minPrice);
            if (maxPrice) filter['pricing.basePrice'].$lte = parseInt(maxPrice);
        }

        if (search) {
            const term = new RegExp(escapeRegex(search), 'i');
            filter.$or = [
                { name: term },
                { description: term }
            ];
        }

        // Sorting options
        let sortOption = { createdAt: -1 }; // default: latest
        if (sort === 'topRated') sortOption = { 'rating.average': -1 };
        else if (sort === 'inDemand') sortOption = { 'rating.count': -1 };
        else if (sort === 'latest') sortOption = { createdAt: -1 };
        else if (sort === 'priceAsc') sortOption = { 'pricing.basePrice': 1 };
        else if (sort === 'priceDesc') sortOption = { 'pricing.basePrice': -1 };

        const venues = await Venue.find(filter)
            .populate('owner', 'name email')
            .limit(parseInt(limit))
            .skip((parseInt(page) - 1) * parseInt(limit))
            .sort(sortOption)
            .lean();

        const total = await Venue.countDocuments(filter);

        return {
            venues,
            totalPages: Math.ceil(total / parseInt(limit)),
            currentPage: parseInt(page),
            total
        };
    },

    // Get venues by owner (for venue owner dashboard)
    async getVenuesByOwner(ownerId) {
        const venues = await Venue.find({ 
            owner: ownerId, 
            isDeleted: { $ne: true } 
        }).sort({ createdAt: -1 }).lean();
        return venues;
    },

    // Get nearby venues
    async getNearbyVenues(lat, lng, radius = 10000) {
        const venues = await Venue.find({
            location: {
                $near: {
                    $geometry: {
                        type: 'Point',
                        coordinates: [parseFloat(lng), parseFloat(lat)]
                    },
                    $maxDistance: parseInt(radius)
                }
            },
            status: 'approved',
            isActive: true,
            isDeleted: { $ne: true }
        }).populate('owner', 'name email').lean();

        return venues;
    },

    // Get venue by ID
    async getVenueById(id) {
        const venue = await Venue.findById(id).populate('owner', 'name email avatar').lean();
        if (!venue) {
            throw new Error('Venue not found');
        }
        return venue;
    },

    /**
     * 'YYYY-MM-DD' days from today on that active (pending/accepted) personal
     * bookings hold at this venue. Public: day keys only, nothing about who.
     *
     * The calendar used to read only `blockedDates`, which a booking reaches
     * only once accepted - so a day held by a pending or just-paid booking still
     * showed as free, and the guest found out only when the submit was refused.
     */
    async getUnavailableDates(venueId) {
        const Booking = require('../models/Booking');
        const { bookingDayKeys } = require('../utils/venueAvailability');
        const todayKey = new Date().toISOString().split('T')[0];
        const today = new Date(`${todayKey}T00:00:00Z`);

        const bookings = await Booking.find({
            venue: venueId,
            status: { $in: ['pending', 'accepted'] },
            $or: [{ bookingDate: { $gte: today } }, { endDate: { $gte: today } }],
        }).select('bookingDate endDate').lean();

        const days = new Set();
        for (const b of bookings) {
            for (const key of bookingDayKeys(b.bookingDate, b.endDate)) {
                if (key >= todayKey) days.add(key);
            }
        }
        return [...days].sort();
    },

    /**
     * When upcoming events at this venue run, for the Create Event calendar.
     *
     * An event clashes with another only where their times overlap (two events
     * can share a day), and a pending event never reaches blockedDates, so the
     * calendar could not see it: the organiser only found out from the error on
     * the last step. Times only - no names, so a pending event stays private.
     * Same statuses eventService.createEvent checks against.
     */
    async getEventSlots(venueId) {
        const Event = require('../models/Event');
        const events = await Event.find({
            venue: venueId,
            status: { $nin: ['cancelled', 'rejected'] },
            isDeleted: { $ne: true },
            endDateTime: { $gte: new Date() },
        }).select('startDateTime endDateTime').sort({ startDateTime: 1 }).limit(500).lean();
        return events.map((e) => ({ _id: String(e._id), start: e.startDateTime, end: e.endDateTime }));
    },

    /**
     * Block or unblock whole days for a booking the owner took elsewhere.
     *
     * Only the owner's own 'busy' slots are added or removed, one atomic update
     * per day, so the days bookings and events hold are never touched. A day a
     * guest has requested or booked, or an event is on, cannot be blocked: the
     * owner answers that request instead. Returns the venue's blockedDates.
     *
     * @param {string} venueId
     * @param {string} ownerId
     * @param {{ block?: string[], unblock?: string[] }} days 'YYYY-MM-DD' keys
     */
    async setOwnerBlockedDays(venueId, ownerId, { block = [], unblock = [] } = {}) {
        const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);
        const DAY = /^\d{4}-\d{2}-\d{2}$/;
        const all = [...block, ...unblock];
        if (all.length === 0) throw fail(400, 'Pick at least one day');
        if (all.length > 366) throw fail(400, 'Change at most a year of days at a time');
        if (!all.every((k) => typeof k === 'string' && DAY.test(k) && !Number.isNaN(Date.parse(`${k}T00:00:00Z`)))) {
            throw fail(400, 'Days must be dates like 2026-11-12');
        }
        if (block.some((k) => unblock.includes(k))) throw fail(400, 'A day cannot be blocked and unblocked at once');

        const venue = await Venue.findById(venueId).select('owner isDeleted').lean();
        if (!venue || venue.isDeleted) throw fail(404, 'Venue not found');
        if (String(venue.owner) !== String(ownerId)) throw fail(403, 'You do not own this venue');

        const { localDayKey } = require('../utils/venueAvailability');
        const todayKey = localDayKey(new Date());
        if (block.some((k) => k < todayKey)) throw fail(400, 'Past days cannot be blocked');

        if (block.length) {
            // What guests and events already hold on those days.
            const [bookedDays, eventSlots] = await Promise.all([
                venueService.getUnavailableDates(venueId),
                venueService.getEventSlots(venueId),
            ]);
            const held = new Set(bookedDays);
            for (const e of eventSlots) {
                const end = localDayKey(e.end);
                for (let d = new Date(e.start); localDayKey(d) <= end; d.setDate(d.getDate() + 1)) held.add(localDayKey(d));
            }
            const clash = block.filter((k) => held.has(k)).sort();
            if (clash.length) {
                throw fail(409, 'Some of these days already have a booking or event. Answer that request instead of blocking the day.', { days: clash });
            }
        }

        const busy = { startTime: '00:00', endTime: '23:59', type: 'busy' };
        for (const key of block) {
            // A new day entry, or a busy slot on an existing one - never both.
            const added = await Venue.updateOne(
                { _id: venueId, 'blockedDates.date': { $ne: key } },
                { $push: { blockedDates: { date: key, slots: [busy] } } },
            );
            if (!added.modifiedCount) {
                await Venue.updateOne(
                    { _id: venueId, blockedDates: { $elemMatch: { date: key, 'slots.type': { $ne: 'busy' } } } },
                    { $push: { 'blockedDates.$.slots': busy } },
                );
            }
        }
        for (const key of unblock) {
            await Venue.updateOne(
                { _id: venueId, 'blockedDates.date': key },
                { $pull: { 'blockedDates.$.slots': { type: 'busy' } } },
            );
        }
        if (unblock.length) {
            // Drop the day entries the unblock emptied.
            await Venue.updateOne(
                { _id: venueId },
                { $pull: { blockedDates: { date: { $in: unblock }, slots: { $size: 0 } } } },
            );
        }

        const after = await Venue.findById(venueId).select('blockedDates').lean();
        return after.blockedDates || [];
    },

    // Create venue
    async createVenue(data) {
        // Same protected fields as an update: a new listing starts 'pending' for
        // admin review at the default platform fee. Create used to take the body
        // whole, so a venue could be created already approved, verified, rated and
        // at 0% platform fee. `owner` is the signed-in caller, set by the route.
        const safe = venueService.stripProtectedFields(data);
        // Every venue needs a day rate above 0; demand prices are checked too.
        safe.pricing = normalisePricing(safe.pricing);
        // Trust boundary: payoutAccount comes from the client through a
        // .passthrough() body schema, so verify it is one of this owner's own saved
        // accounts before storing it. Anything else becomes null = use my default.
        const { sanitizePayoutAccount } = require('../utils/payoutAccount');
        const venue = await Venue.create({
            ...safe,
            owner: data.owner,
            payoutAccount: await sanitizePayoutAccount(data.owner, data.payoutAccount),
        });
        return venue;
    },

    // Fields an owner must never set through a normal venue update. Stripping
    // them here - in the single shared update path, not per-route - closes a
    // mass-assignment hole: without it a venue owner could PUT { status:
    // 'approved' } to self-approve (bypassing admin review), forge
    // rating/isVerified, or reassign `owner` to steal/dump a venue. Status is
    // changed only via adminService; soft-delete only via deleteVenue.
    // platformFeePercentage is the platform's commission - not the owner's to set
    // (it was writable, so an owner could list their venue at 0%).
    // blockedDates/daySlots: the calendar also holds the days bookings and
    // events took. Writing the whole array from a page loaded earlier erased any
    // hold added since; owners change their own busy days through
    // setOwnerBlockedDays, which touches nothing else.
    PROTECTED_VENUE_FIELDS: ['status', 'isVerified', 'isDeleted', 'deletedAt', 'owner', 'rating',
        'platformFeePercentage', '_id', 'createdAt', 'updatedAt', 'blockedDates', 'daySlots'],

    // Pure: return a copy of an update payload with owner-protected fields
    // removed (dotted paths like "rating.average" included). Kept separate so it
    // is unit-testable without a DB round-trip.
    stripProtectedFields(updateData = {}) {
        return stripProtected(updateData, venueService.PROTECTED_VENUE_FIELDS);
    },

    // Update venue
    async updateVenue(id, updateData) {
        const safe = venueService.stripProtectedFields(updateData);

        // Pricing changes as a whole object, checked like on create: a dotted
        // "pricing.pricePerDay" could otherwise set the day rate to 0.
        for (const key of Object.keys(safe)) {
            if (key.startsWith('pricing.')) delete safe[key];
        }
        if ('pricing' in safe) {
            safe.pricing = normalisePricing(safe.pricing);
        }

        // Same trust boundary as createVenue. payoutAccount is deliberately not in
        // PROTECTED_VENUE_FIELDS - an owner may move their own earnings to another of
        // their own accounts - but the id still arrives through a .passthrough()
        // schema, so it has to be checked against their saved accounts here too.
        // The edit form sends this field on every save, so create-only checking left
        // the update path able to store a foreign id.
        if ('payoutAccount' in safe) {
            const { sanitizePayoutAccount } = require('../utils/payoutAccount');
            const existing = await Venue.findById(id).select('owner').lean();
            if (!existing) throw new Error('Venue not found');
            safe.payoutAccount = await sanitizePayoutAccount(existing.owner, safe.payoutAccount);
        }

        const before = 'images' in safe ? await Venue.findById(id).select('images').lean() : null;

        const venue = await Venue.findByIdAndUpdate(
            id,
            { $set: safe },
            { new: true }
        );
        if (!venue) {
            throw new Error('Venue not found');
        }

        // Photos taken off the listing are deleted from storage once the edit
        // is saved (not when the owner clicks remove, which a cancelled edit
        // would leave as a broken image).
        if (before) {
            require('./uploadService').deleteRemovedImages(before.images, venue.images);
        }
        return venue;
    },

    // Delete venue (soft delete)
    async deleteVenue(id) {
        const venue = await Venue.findByIdAndUpdate(
            id,
            {
                $set: {
                    isDeleted: true,
                    deletedAt: new Date(),
                    isActive: false
                }
            },
            { new: true }
        );
        if (!venue) {
            throw new Error('Venue not found');
        }
        return { message: 'Venue deleted successfully', venue };
    },

    // Update availability
    async updateAvailability(id, availability) {
        const venue = await Venue.findByIdAndUpdate(
            id,
            { $set: { availability } },
            { new: true }
        );
        if (!venue) {
            throw new Error('Venue not found');
        }
        return venue;
    },

    // Submit a venue review (Req 14.1, 14.2, 14.4, 14.5)
    async submitReview(userId, venueId, rating, comment) {
        // 1. Check that user has a completed booking at this venue
        const completedBooking = await Booking.findOne({
            user: userId,
            venue: venueId,
            status: 'completed'
        });
        if (!completedBooking) {
            const err = new Error('You must complete a booking before reviewing');
            err.status = 403;
            throw err;
        }

        // 2. Create review — unique index { user, venue } rejects duplicates
        let review;
        try {
            review = await VenueReview.create({ user: userId, venue: venueId, rating, comment });
        } catch (err) {
            if (err.code === 11000) {
                const dupErr = new Error('A review has already been submitted for this venue');
                dupErr.status = 409;
                throw dupErr;
            }
            throw err;
        }

        // 3. Recalculate venue rating
        const venue = await Venue.findById(venueId);
        const currentAverage = (venue.rating && venue.rating.average) || 0;
        const currentCount = (venue.rating && venue.rating.count) || 0;
        const newAverage = (currentAverage * currentCount + rating) / (currentCount + 1);
        const newCount = currentCount + 1;

        await Venue.findByIdAndUpdate(venueId, {
            $set: { 'rating.average': newAverage, 'rating.count': newCount }
        });

        return review;
    },

    // Pure: the refund base and refund amount for a booking under the
    // Cancellation_Policy (Req 6.1/6.2, Property 7). Kept separate from
    // processCancellation so it is the single source of truth for the refund
    // math and is unit-testable without a DB round-trip.
    //
    // amountPaid = deposit + balance when the balance is paid, deposit alone
    // otherwise (installment); for a full schedule it is deposit (or, for legacy
    // bookings with no recorded deposit, the total). refundAmount is that base
    // times the applicable refund percentage, rounded to paise.
    computeRefund(paymentSchedule, totalAmount, refundPercentage) {
        const s = paymentSchedule || {};
        const amountPaid = s.type === 'installment'
            ? roundMoney((s.depositAmount || 0) + (s.balanceStatus === 'paid' ? (s.balanceAmount || 0) : 0))
            : roundMoney(s.depositAmount || totalAmount);
        return {
            amountPaid,
            refundAmount: roundMoney(amountPaid * refundPercentage / 100),
        };
    },

    // Validate cancellation policy constraints
    validateCancellationPolicy(policy) {
        const { freeCancellationHours, noCancellationHours } = policy;
        if (noCancellationHours >= freeCancellationHours) {
            throw new Error('noCancellationHours must be less than freeCancellationHours');
        }
    },

    // Process a booking cancellation according to venue cancellation policy
    /**
     * What the venue's cancellation policy refunds if `booking` is cancelled by
     * the person who booked it, now. Pure, so a guest's cancellation and an
     * organiser cancelling an event at a paid venue use the same rule.
     *
     * The policy is about money paid: a request, or an accepted booking not paid
     * for yet, refunds nothing and can always be withdrawn. Inside the
     * no-cancellation window nothing is refunded (`windowClosed`).
     *
     * @returns {{ refundType: 'none'|'full'|'partial', refundPercentage: number, windowClosed: boolean }}
     */
    cancellationRefund(venue, booking, now = new Date()) {
        const policy = venue && venue.cancellationPolicy && venue.cancellationPolicy.freeCancellationHours
            ? venue.cancellationPolicy
            : DEFAULT_CANCELLATION_POLICY;
        const { freeCancellationHours, partialRefundPercentage, noCancellationHours } = policy;

        const start = new Date(booking.bookingDate);
        const [hours, minutes] = String(booking.startTime || '00:00').split(':').map(Number);
        start.setHours(hours || 0, minutes || 0, 0, 0);
        const hoursRemaining = (start.getTime() - now.getTime()) / (1000 * 60 * 60);

        if (booking.paymentStatus !== 'paid') return { refundType: 'none', refundPercentage: 0, windowClosed: false };
        if (hoursRemaining <= noCancellationHours) return { refundType: 'none', refundPercentage: 0, windowClosed: true };
        if (hoursRemaining > freeCancellationHours) return { refundType: 'full', refundPercentage: 100, windowClosed: false };
        return { refundType: 'partial', refundPercentage: partialRefundPercentage, windowClosed: false };
    },

    async processCancellation(bookingId, userId) {
        const booking = await Booking.findById(bookingId);
        if (!booking) {
            throw new Error('Booking not found');
        }

        // Req 6.4 — a booking cancelled for non-payment (deposit forfeited) is
        // outside the Cancellation_Policy and cannot be voluntarily cancelled again.
        if (booking.paymentSchedule && booking.paymentSchedule.balanceStatus === 'forfeited') {
            throw new Error('This booking was cancelled for non-payment and cannot be cancelled again');
        }

        // An event's venue booking stands or falls with the event: cancelling
        // it alone would leave the event waiting on a venue it no longer has.
        if (booking.event) {
            throw new Error('This venue booking is for your event. Cancel the event instead - any refund follows the venue policy.');
        }

        const venue = await Venue.findById(booking.venue);
        if (!venue) {
            throw new Error('Venue not found');
        }

        const result = venueService.cancellationRefund(venue, booking);
        if (result.windowClosed) {
            throw new Error('Cancellation window has passed');
        }
        delete result.windowClosed;

        // Claim the cancellation atomically: only a live booking can be cancelled,
        // and only once - this used to re-cancel cancelled, rejected or completed
        // bookings, and two quick taps would both proceed.
        const claimed = await Booking.findOneAndUpdate(
            { _id: bookingId, status: { $in: ['pending', 'accepted'] } },
            { $set: { status: 'cancelled', cancellationReason: 'cancelled_by_guest' } },
            { new: true }
        );
        if (!claimed) {
            throw new Error(`A ${booking.status} booking cannot be cancelled`);
        }

        // Req 6.1/6.2 — refund is a percentage of the amount actually paid:
        // deposit + balance when the balance is paid, otherwise the deposit alone
        // (or the full total for legacy/full bookings). Nothing was paid on a
        // booking whose payment never went through, so nothing is refunded.
        // Platform fee and GST are not part of the base (Req 6.2 counts the
        // installments, not the charges on top of them).
        // Every refund waits for an admin: these are requests in "Refunds to be
        // done", and no money moves until one is paid. Previously the refund was
        // computed, returned to the client - and never paid at all.
        const refundService = require('./refundService');
        const { amountPaid, refunds } = await refundService.raiseBookingRefunds(booking, result.refundPercentage, {
            reasonDetails: `Guest cancelled booking ${bookingId} (${result.refundPercentage}% under the venue policy)`,
            userId,
        });

        result.amountPaid = amountPaid;
        result.refundAmount = roundMoney(refunds.reduce((sum, r) => sum + r.amount, 0));
        result.refundStatus = refunds.length ? 'pending_approval' : 'none';
        result.refunds = refunds.map(r => ({ _id: r._id, amount: r.amount, status: r.status }));

        // Free the dates for other guests. This never happened on cancellation, so
        // a cancelled booking kept its days blocked on the venue calendar.
        try {
            const { releaseBookingDays } = require('../utils/venueAvailability');
            releaseBookingDays(venue, booking);
            await venue.save({ validateModifiedOnly: true });
        } catch (err) {
            console.error(`Failed to release calendar for booking ${bookingId}:`, err.message);
        }

        const notificationService = require('./notificationService');
        const when = new Date(booking.bookingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        notificationService.createNotification({
            userId: booking.user,
            type: 'booking_cancelled',
            title: 'Booking cancelled',
            message: result.refundAmount > 0
                ? `Your booking at ${venue.name} on ${when} is cancelled. A refund of ₹${result.refundAmount} has been requested and will be sent once approved.`
                : `Your booking at ${venue.name} on ${when} is cancelled.`,
            data: { referenceId: booking._id, referenceModel: 'Booking', actionUrl: '/dashboard/bookings' },
            priority: 'medium'
        }).catch(err => console.error('booking_cancelled notification failed:', err.message));
        notificationService.createNotification({
            userId: venue.owner,
            type: 'booking_cancelled',
            title: 'Booking cancelled',
            message: `A booking at ${venue.name} on ${when} was cancelled by the guest. The date is free again.`,
            data: { referenceId: booking._id, referenceModel: 'Booking', actionUrl: `/venue-portal/bookings/${booking._id}` },
            priority: 'medium'
        }).catch(err => console.error('booking_cancelled owner notification failed:', err.message));

        return result;
    }
};

module.exports = venueService;
