const Event = require('../models/Event');
const PrivateEventAccess = require('../models/PrivateEventAccess');
const ScanningCode = require('../models/ScanningCode');
const Ticket = require('../models/Ticket');
const { PURCHASE_FALLBACK_TIER } = require('./ticketTiers');
const { citySlug } = require('../utils/citySlug');
const crypto = require('crypto');
const { escapeRegex } = require('../utils/escapeRegex');

/**
 * Statuses a public listing will show. `approved` is what the approval flow
 * actually sets, but `upcoming` and `ongoing` are valid values in the schema
 * enum - matching only `approved` meant anything moved to one of those was
 * silently invisible with no indication why.
 */
const PUBLICLY_VISIBLE_STATUSES = ['approved', 'upcoming', 'ongoing'];

/**
 * The venue days an event occupies, each with the slot it takes that day: from
 * its start time on the first day to its end time on the last, whole days in
 * between. Days are the server's local calendar days (TZ=Asia/Kolkata in
 * production), so an event at 2am IST sits on that IST day, not the UTC one.
 * `legacyTimes` holds the slot in both local and UTC clock time, to recognise
 * slots written while the server still ran on UTC.
 */
function eventVenueDays(event) {
    const { localDayKey } = require('../utils/venueAvailability');
    const start = new Date(event.startDateTime);
    const end = new Date(event.endDateTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return [];
    const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const local = (d) => hhmm(d.getHours(), d.getMinutes());
    const utc = (d) => hhmm(d.getUTCHours(), d.getUTCMinutes());
    const firstKey = localDayKey(start);
    const lastKey = localDayKey(end);
    const days = [];
    const last = Date.parse(`${lastKey}T00:00:00Z`);
    for (let t = Date.parse(`${firstKey}T00:00:00Z`); t <= last && days.length < 366; t += 24 * 3600 * 1000) {
        const key = new Date(t).toISOString().split('T')[0];
        const slot = (fmt) => ({
            startTime: key === firstKey ? fmt(start) : '00:00',
            endTime: key === lastKey ? fmt(end) : '23:59',
        });
        days.push({ key, ...slot(local), legacyTimes: [slot(local), slot(utc)] });
    }
    return days;
}

/**
 * Fields an organizer may set through POST/PUT /events. Approval state, the
 * platform fee, sales counters and featured/active/deleted flags are decided by
 * the server and the approval flow. Create and update both used to take the raw
 * body, so a request could arrive already approved, at 0% platform fee, or with
 * its organizer swapped to redirect payouts.
 */
const ORGANIZER_EDITABLE_FIELDS = [
    'venue', 'name', 'description', 'coverPhoto', 'images', 'startDateTime', 'endDateTime',
    'eventType', 'ticketType', 'ticketPrice', 'maxAttendees', 'privateCode', 'category',
    'tags', 'friendsAndFamilyStay', 'allowAlcohol', 'customVenue', 'termsAndConditions',
    'payoutAccount', 'ticketTiers',
];

function pickOrganizerFields(data) {
    const picked = {};
    for (const key of ORGANIZER_EDITABLE_FIELDS) {
        if (data && data[key] !== undefined) picked[key] = data[key];
    }
    return picked;
}

const tierKey = (name) => String(name || '').trim().toLowerCase();

/**
 * Merge an edited tier list onto the stored one without losing sales.
 *
 * The edit form sends tiers without soldCount, so a plain $set reset every
 * tier's sold count to 0 and let it sell out a second time. Sold counts are
 * carried over by tier name. A tier that has sold tickets cannot be removed or
 * renamed (its name is what tier-scoped door scanners match on), nor shrunk
 * below what it has already sold.
 */
function mergeTicketTiers(existingTiers, incomingTiers) {
    const existing = new Map((existingTiers || []).map(t => [tierKey(t.name), t]));
    const incomingKeys = new Set(incomingTiers.map(t => tierKey(t.name)));

    for (const [key, tier] of existing) {
        if ((tier.soldCount || 0) > 0 && !incomingKeys.has(key)) {
            throw new Error(`Tier "${tier.name}" has sold tickets and cannot be removed or renamed`);
        }
    }

    return incomingTiers.map(t => {
        const prior = existing.get(tierKey(t.name));
        const soldCount = prior ? (prior.soldCount || 0) : 0;
        if (Number(t.maxQuantity) < soldCount) {
            throw new Error(`Tier "${t.name}" has already sold ${soldCount} tickets; its quantity cannot be lower than that`);
        }
        const { soldCount: _ignored, ...rest } = t;
        return prior && prior._id ? { ...rest, _id: prior._id, soldCount } : { ...rest, soldCount };
    });
}

const isCustomVenue = (customVenue) =>
    !!customVenue && (customVenue.isCustom === true || customVenue.isCustom === 'true');

const eventService = {
    ORGANIZER_EDITABLE_FIELDS,

    // Get all events
    // viewerId: the signed-in caller, if any. Private events are listed only to
    // their organizer, on their own dashboard listing (?organizer=<self>); every
    // other listing is public events only, and never carries an access code.
    async getAllEvents(query = {}, { viewerId = null } = {}) {
        const { page = 1, limit = 10, eventType, status, category, organizer, sort, search, city, showCompleted, todayOnly, weekend, ticketType, dateFilter } = query;
        const filter = { isDeleted: { $ne: true } }; // Always exclude deleted events
        const ownListing = !!organizer && !!viewerId && String(organizer) === String(viewerId);
        if (ownListing) {
            if (eventType) filter.eventType = eventType;
        } else {
            // A private event is reachable only through its link. Listings used to
            // include them (with the access code) unless the caller asked for public.
            filter.eventType = 'public';
        }
        if (category && category !== 'All') filter.category = category;

        // Conditions that each need their own $or are collected here and combined
        // with $and at the end. Assigning filter.$or directly (as city and search
        // both used to) means whichever runs second silently discards the first.
        const andConditions = [];

        if (city && city !== 'All') {
            const Venue = require('../models/Venue');
            // Slug match, so "Bengaluru" and "Bangalore" find the same events and
            // the caller's string never reaches a regex engine.
            const slug = citySlug(city);
            const venuesInCity = await Venue.find({ 'address.citySlug': slug }).select('_id');
            // An event is in a city either because its listed venue is there, or
            // because it carries its own custom venue with the city on the event.
            // Matching on venue id alone dropped every custom-venue event (they
            // have venue: null) whenever a city was applied - and a city is applied
            // automatically on first load, so those events were never visible at
            // all.
            andConditions.push({
                $or: [
                    { venue: { $in: venuesInCity.map(v => v._id) } },
                    { 'customVenue.citySlug': slug }
                ]
            });
        }

        // Ticket type filter (free/paid)
        if (ticketType === 'free') {
            filter.ticketType = 'free';
        } else if (ticketType === 'paid') {
            filter.ticketType = 'paid';
        }

        // If querying by organizer (dashboard), show their events excluding deleted
        // Otherwise, only show approved/upcoming and active events (public listing)
        if (organizer) {
            filter.organizer = organizer;
            if (status) filter.status = status;
            // By default, hide completed/past events in dashboard unless showCompleted=true
            if (showCompleted !== 'true' && showCompleted !== true) {
                filter.endDateTime = { $gte: new Date() }; // Only upcoming/ongoing events
            }
        } else {
            // Public listing - show only fully approved events that have not ended.
            // Gate on endDateTime (not startDateTime) so an event that has started
            // but already finished isn't listed, and exclude completed events
            // explicitly (approved is required, completed is never listed).
            filter.status = { $in: PUBLICLY_VISIBLE_STATUSES };
            filter.isActive = { $ne: false };
            filter.endDateTime = { $gte: new Date() }; // Not yet ended (upcoming or ongoing)
        }

        // Today Only filter (events within next 24 hours)
        if (todayOnly === 'true' || todayOnly === true) {
            const now = new Date();
            const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            filter.startDateTime = { $gte: now, $lte: in24Hours };
        }

        // Weekend filter (Friday 6PM to Sunday midnight)
        if (weekend === 'true' || weekend === true) {
            const now = new Date();
            const dayOfWeek = now.getDay(); // 0 = Sunday, 5 = Friday, 6 = Saturday
            
            // Calculate next Friday 6PM
            let fridayStart = new Date(now);
            const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
            if (daysUntilFriday === 0 && now.getHours() >= 18) {
                // It's Friday after 6PM, use today
            } else if (daysUntilFriday === 0) {
                // It's Friday before 6PM, use today at 6PM
            } else {
                fridayStart.setDate(now.getDate() + daysUntilFriday);
            }
            fridayStart.setHours(18, 0, 0, 0);

            // Calculate Sunday midnight (end of Sunday)
            let sundayEnd = new Date(fridayStart);
            sundayEnd.setDate(fridayStart.getDate() + (7 - fridayStart.getDay()) % 7); // Move to Sunday
            if (sundayEnd <= fridayStart) {
                sundayEnd.setDate(sundayEnd.getDate() + 7);
            }
            sundayEnd.setHours(23, 59, 59, 999);

            // If we're already past Sunday, get next weekend
            if (now > sundayEnd) {
                fridayStart.setDate(fridayStart.getDate() + 7);
                sundayEnd.setDate(sundayEnd.getDate() + 7);
            }

            filter.startDateTime = { $gte: fridayStart, $lte: sundayEnd };
        }

        // Date filter (today, tomorrow, thisWeek)
        if (dateFilter === 'today') {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayEnd = new Date();
            todayEnd.setHours(23, 59, 59, 999);
            filter.startDateTime = { $gte: todayStart, $lte: todayEnd };
        } else if (dateFilter === 'tomorrow') {
            const tomorrowStart = new Date();
            tomorrowStart.setDate(tomorrowStart.getDate() + 1);
            tomorrowStart.setHours(0, 0, 0, 0);
            const tomorrowEnd = new Date(tomorrowStart);
            tomorrowEnd.setHours(23, 59, 59, 999);
            filter.startDateTime = { $gte: tomorrowStart, $lte: tomorrowEnd };
        }

        if (search) {
            const searchRegex = new RegExp(escapeRegex(search), 'i');
            andConditions.push({
                $or: [
                    { name: searchRegex },
                    { description: searchRegex }
                ]
            });
        }

        if (andConditions.length > 0) filter.$and = andConditions;

        // Sorting options
        let sortOption = { startDateTime: 1 }; // default: upcoming (earliest first)
        if (sort === 'upcoming') sortOption = { startDateTime: 1 };
        // `top` sorted on stats.attendees / stats.interested, neither of which
        // exists on the Event schema - so "Popular" silently fell back to Mongo's
        // natural order. currentAttendees is the real counter.
        else if (sort === 'top') sortOption = { currentAttendees: -1, createdAt: -1 };
        else if (sort === 'latest') sortOption = { createdAt: -1 };

        // Featured events lead every public listing, whatever the secondary sort.
        // A promoted event is worth surfacing above the chronological/popular order,
        // but only on the public list - the organizer's own dashboard should stay in
        // plain date order so they can find a specific event. Object key order is the
        // tiebreak order Mongo applies, so isFeatured first means "featured, then the
        // chosen sort within each group".
        if (!organizer) {
            sortOption = { isFeatured: -1, ...sortOption };
        }

        const events = await Event.find(filter)
            .select(ownListing ? undefined : '-privateCode')
            .populate('organizer', 'name email avatar verificationBadge')
            .populate('venue', 'name address images')
            .limit(parseInt(limit))
            .skip((parseInt(page) - 1) * parseInt(limit))
            .sort(sortOption)
            .lean();

        await eventService.attachOrganizerBrands(events);

        const total = await Event.countDocuments(filter);

        return {
            events,
            totalPages: Math.ceil(total / parseInt(limit)),
            currentPage: parseInt(page),
            total
        };
    },

    /**
     * Attach each organizer's approved brand identity to a list of lean events.
     *
     * An event run under a brand should carry the brand's name and photo, not the
     * personal account behind it - that is the identity the audience follows and the
     * one on the poster. The organizer object is still returned untouched, so
     * anything that needs the real account (admin queues, payouts, ownership checks)
     * is unaffected; this only adds `organizerBrand` for presentation.
     *
     * Only `status: 'approved'` brands qualify. A pending applicant billing their
     * events under an unreviewed brand name is the same self-verification hole that
     * was just closed on the badge.
     *
     * ponytail: one batched query for the whole page rather than a lookup per event.
     * Ceiling: it is a second round trip. If event listings ever need to filter or
     * sort by brand, this becomes a $lookup in the aggregation instead.
     */
    async attachOrganizerBrands(events) {
        const list = Array.isArray(events) ? events : [events];
        const organizerId = e => String(e?.organizer?._id || e?.organizer || '');

        const ids = [...new Set(list.map(organizerId).filter(Boolean))];
        if (!ids.length) return events;

        const BrandProfile = require('../models/BrandProfile');
        const brands = await BrandProfile.find({ user: { $in: ids }, status: 'approved' })
            .select('user name type profilePhoto')
            .lean();

        const byUser = new Map(brands.map(b => [String(b.user), b]));
        for (const event of list) {
            const brand = byUser.get(organizerId(event));
            if (!brand) continue;
            event.organizerBrand = {
                _id: brand._id,
                name: brand.name,
                type: brand.type,
                profilePhoto: brand.profilePhoto || null,
            };
        }

        return events;
    },

    // Get upcoming events (public, approved/upcoming)
    async getUpcomingEvents(query = {}) {
        const { limit = 10, category } = query;
        const filter = {
            startDateTime: { $gte: new Date() },
            // Same visibility rule as getAllEvents - kept on the shared constant so
            // the two listings cannot disagree about what counts as live.
            status: { $in: PUBLICLY_VISIBLE_STATUSES },
            eventType: 'public',
            isActive: { $ne: false },
            isDeleted: { $ne: true }
        };
        if (category) filter.category = category;

        const events = await Event.find(filter)
            .populate('organizer', 'name avatar verificationBadge')
            .populate('venue', 'name address')
            .limit(limit * 1)
            .sort({ startDateTime: 1 })
            .lean();

        await eventService.attachOrganizerBrands(events);

        return events;
    },

    // Get event by ID.
    // viewerId (optional): the id of the authenticated viewer, if any. A private
    // event is only resolvable by link for a NON-owner viewer once it is admin-
    // approved; the organizer viewing their own private event always sees it.
    // Fail closed: an anonymous / non-owner viewer of an unapproved private event
    // gets "Event not found" rather than a leaked draft.
    async getEventById(id, viewerId = null, { viewerIsAdmin = false } = {}) {
        const event = await Event.findById(id)
            .populate('organizer', 'name email avatar verificationBadge')
            .populate('venue', 'name description address images capacity')
            .lean();
        if (!event) {
            throw new Error('Event not found');
        }

        const organizerId = (event.organizer?._id || event.organizer)?.toString();
        const isOwner = !!viewerId && !!organizerId && organizerId === viewerId.toString();
        if (event.eventType === 'private' && event.adminApproval?.status !== 'approved' && !isOwner && !viewerIsAdmin) {
            throw new Error('Event not found');
        }

        // The access code is the organizer's to hand out. It used to be sent to
        // every visitor, and the page then "checked" the code against itself.
        if (!isOwner && !viewerIsAdmin) delete event.privateCode;

        await eventService.attachOrganizerBrands(event);

        return event;
    },

    // Create event
    async createEvent(input) {
        // Only organizer-settable fields survive; approval state is decided below.
        const data = { ...pickOrganizerFields(input), organizer: input.organizer };
        if (Array.isArray(data.ticketTiers)) {
            data.ticketTiers = data.ticketTiers.map(({ soldCount, ...t }) => ({ ...t, soldCount: 0 }));
        }

        // Check for time slot conflicts at the venue
        let { venue, startDateTime, endDateTime } = data;
        
        // Handle empty string venue (from frontend) to avoid ObjectId cast errors
        if (venue === '') {
            venue = null;
            data.venue = null;
        }

        // Validate startDateTime is not in the past
        const now = new Date();
        const eventStart = new Date(startDateTime);
        const eventEnd = new Date(endDateTime);

        if (eventStart < now) {
            throw new Error('Event start date/time cannot be in the past');
        }

        // Validate end datetime is after start datetime
        if (eventEnd <= eventStart) {
            throw new Error('End date/time must be after start date/time');
        }

        if (venue && startDateTime && endDateTime) {
            // Find events at the same venue that overlap with this time range
            const conflictingEvents = await Event.find({
                venue: venue,
                status: { $nin: ['cancelled', 'rejected'] },
                // Check for any overlap: existing event overlaps if:
                // existingStart < newEnd AND existingEnd > newStart
                $and: [
                    { startDateTime: { $lt: eventEnd } },
                    { endDateTime: { $gt: eventStart } }
                ]
            });

            if (conflictingEvents.length > 0) {
                const conflict = conflictingEvents[0];
                const conflictStart = new Date(conflict.startDateTime).toLocaleString();
                const conflictEnd = new Date(conflict.endDateTime).toLocaleString();
                throw new Error(`Time slot conflict: This venue is already booked from ${conflictStart} to ${conflictEnd} for "${conflict.name}"`);
            }

            // Owner-blocked dates (offline/external bookings). The owner marks a
            // day 'busy' on their calendar when it's taken elsewhere; the event
            // path only checked other events, so an event could still land on a
            // day the owner had given away offline. Reject if any day the event
            // spans carries a busy block.
            const Venue = require('../models/Venue');
            const { isDayBlockedByOwner, overlappingBookingFilter, isVenueBookable } = require('../utils/venueAvailability');
            const venueDoc = await Venue.findById(venue).select('blockedDates status isActive isDeleted');
            // Only an approved, active, undeleted venue can host an event.
            if (!isVenueBookable(venueDoc)) {
                throw new Error('This venue is not available');
            }
            const eventDays = eventVenueDays({ startDateTime: eventStart, endDateTime: eventEnd });
            if (eventDays.some(({ key }) => isDayBlockedByOwner(venueDoc?.blockedDates, key))) {
                throw new Error('This venue is unavailable on one or more of the selected dates');
            }

            // Personal (day-rate) bookings hold whole days; an event must not land
            // on a day a guest has already booked.
            const Booking = require('../models/Booking');
            const bookingClash = eventDays.length > 0 && await Booking.findOne(
                overlappingBookingFilter(venue, eventDays[0].key, eventDays[eventDays.length - 1].key)
            ).select('_id').lean();
            if (bookingClash) {
                throw new Error('This venue is unavailable on one or more of the selected dates');
            }
        }

        // Auto-approve venue for personal (custom) venue events
        if (data.customVenue && (data.customVenue.isCustom === true || data.customVenue.isCustom === 'true')) {
            data.venueApproval = {
                status: 'approved',
                respondedAt: new Date(),
                respondedBy: 'system',
            };
            // Ensure admin approval stays pending (default), and no venue ID is required
        }

        // --- NEW: Auto-approval for Tagged Organizers ---
        try {
            const User = require('../models/User');
            const organizerUser = await User.findById(data.organizer);
            
            if (organizerUser && (organizerUser.isVerified === true || (organizerUser.verificationBadge && organizerUser.verificationBadge !== 'none'))) {
                console.log(`🚀 Fast Track: Auto-approving admin part for tagged organizer: ${organizerUser.name} (${organizerUser.verificationBadge})`);
                
                data.adminApproval = {
                    status: 'approved',
                    respondedAt: new Date(),
                    respondedBy: 'system'
                };

                // If venue is ALSO approved (like for custom venues), mark entire event as approved
                if (data.venueApproval && data.venueApproval.status === 'approved') {
                    data.status = 'approved';
                }
            }
        } catch (err) {
            console.error('Error during auto-approval check:', err.message);
            // Don't fail the create process, just default to manual approval
        }
        // ----------------------------------------------

        // Trust boundary: payoutAccount arrives from the client, so verify it is one
        // of this organizer's own saved accounts. Anything else becomes null, which
        // the payout path reads as "use my default".
        const { sanitizePayoutAccount } = require('../utils/payoutAccount');
        data.payoutAccount = await sanitizePayoutAccount(data.organizer, data.payoutAccount);

        const event = await Event.create(data);

        // If fully approved, update venue availability
        if (event.status === 'approved') {
            await this.updateVenueAvailability(event);
            const booking = await this.createBookingForEvent(event);
            if (booking) {
                event.booking = booking._id;
                await event.save();
            }
        }

        // Send email notification to venue owner (only for non-custom venues)
        if (venue && !data.customVenue?.isCustom) {
            const Venue = require('../models/Venue');
            const User = require('../models/User');
            const emailService = require('./emailService');

            // Fetch venue with owner details
            const venueWithOwner = await Venue.findById(venue).populate('owner', 'name email');
            const organizer = await User.findById(data.organizer).select('name email');

            console.log('🎫 Event created, notifying venue owner...');
            console.log('🏢 Venue:', venueWithOwner?.name);
            console.log('👤 Owner:', venueWithOwner?.owner?.name, venueWithOwner?.owner?.email);
            console.log('🎉 Organizer:', organizer?.name, organizer?.email);

            if (venueWithOwner?.owner?.email && organizer) {
                try {
                    await emailService.sendEventRequestEmail(
                        venueWithOwner.owner.email,
                        venueWithOwner.owner.name || 'Venue Owner',
                        { name: venueWithOwner.name },
                        {
                            name: event.name,
                            startDateTime: event.startDateTime,
                            endDateTime: event.endDateTime,
                            category: event.category,
                            maxAttendees: event.maxAttendees
                        },
                        {
                            name: organizer.name,
                            email: organizer.email
                        }
                    );
                    console.log('✅ Event request email sent to venue owner:', venueWithOwner.owner.email);
                } catch (emailErr) {
                    console.error('❌ Failed to send event request email:', emailErr.message);
                }
            } else {
                console.log('⚠️ Skipping email - venue owner or organizer not found');
            }
        }

        return event;
    },

    // Helper to convert time string to minutes
    timeToMinutes(timeStr) {
        if (!timeStr) return 0;
        const [hours, minutes] = timeStr.split(':').map(Number);
        return hours * 60 + (minutes || 0);
    },

    // Update event
    async updateEvent(id, input) {
        const event = await Event.findById(id);
        if (!event) {
            throw new Error('Event not found');
        }

        let updateData = pickOrganizerFields(input);

        if (Array.isArray(updateData.ticketTiers)) {
            updateData.ticketTiers = mergeTicketTiers(event.ticketTiers, updateData.ticketTiers);
        }

        // Moving the event to a different venue needs that venue's approval: an
        // approval from venue A must not carry over to venue B. Treated like a date
        // change once tickets are sold, since buyers paid for the original venue.
        if ('venue' in updateData || 'customVenue' in updateData) {
            const nextCustom = 'customVenue' in updateData ? isCustomVenue(updateData.customVenue) : isCustomVenue(event.customVenue);
            const nextVenue = nextCustom ? null : ('venue' in updateData ? updateData.venue || null : event.venue);
            const venueChanged = String(nextVenue || '') !== String(event.venue || '');

            if (venueChanged) {
                if (event.currentAttendees > 0) {
                    throw new Error('Cannot change the venue after tickets have been sold. Please contact support.');
                }
                if (nextVenue) {
                    const Venue = require('../models/Venue');
                    const { isVenueBookable } = require('../utils/venueAvailability');
                    const target = require('mongoose').isValidObjectId(nextVenue)
                        ? await Venue.findById(nextVenue).select('status isActive isDeleted').lean()
                        : null;
                    if (!isVenueBookable(target)) {
                        throw new Error('This venue is not available');
                    }
                }
                updateData.venueApproval = nextCustom
                    ? { status: 'approved', respondedAt: new Date(), respondedBy: 'system' }
                    : { status: 'pending' };
                if (!nextCustom && ['approved', 'upcoming', 'ongoing'].includes(event.status)) {
                    updateData.status = 'pending';
                }
            }
        }

        // Check if date/time is being changed and tickets are already sold
        if (updateData.startDateTime || updateData.endDateTime) {
            const currentStart = event.startDateTime ? event.startDateTime.toISOString() : null;
            const newStart = updateData.startDateTime ? new Date(updateData.startDateTime).toISOString() : null;
            
            const currentEnd = event.endDateTime ? event.endDateTime.toISOString() : null;
            const newEnd = updateData.endDateTime ? new Date(updateData.endDateTime).toISOString() : null;
            
            if ((newStart && currentStart !== newStart) || (newEnd && currentEnd !== newEnd)) {
                if (event.currentAttendees > 0) {
                    throw new Error('Cannot change event date or time after tickets have been sold. Please contact support.');
                }
            }
        }

        // Same trust boundary as createEvent: the id arrives through a
        // .passthrough() schema, so an update can carry a payout account belonging to
        // someone else. Checked against this organizer's own saved accounts.
        if ('payoutAccount' in updateData) {
            const { sanitizePayoutAccount } = require('../utils/payoutAccount');
            updateData = {
                ...updateData,
                payoutAccount: await sanitizePayoutAccount(event.organizer, updateData.payoutAccount),
            };
        }

        const updatedEvent = await Event.findByIdAndUpdate(
            id,
            { $set: updateData },
            { new: true, runValidators: true }
        );

        // Photos and a cover taken off the event are deleted from storage.
        if (updatedEvent && ('images' in updateData || 'coverPhoto' in updateData)) {
            require('./uploadService').deleteRemovedImages(
                [...(event.images || []), event.coverPhoto],
                [...(updatedEvent.images || []), updatedEvent.coverPhoto]
            );
        }

        // An approved event holds its venue's days. If it moved venue or dates,
        // free the old days, and hold the new ones if it is still approved.
        const heldDays = PUBLICLY_VISIBLE_STATUSES.includes(event.status) && event.venue;
        const moved = updatedEvent && (
            String(updatedEvent.venue || '') !== String(event.venue || '')
            || +new Date(updatedEvent.startDateTime) !== +new Date(event.startDateTime)
            || +new Date(updatedEvent.endDateTime) !== +new Date(event.endDateTime));
        if (heldDays && moved) {
            await this.releaseVenueForEvent(event);
            if (PUBLICLY_VISIBLE_STATUSES.includes(updatedEvent.status) && updatedEvent.venue) {
                await this.updateVenueAvailability(updatedEvent);
                const booking = await this.createBookingForEvent(updatedEvent);
                if (booking && String(booking._id) !== String(updatedEvent.booking)) {
                    updatedEvent.booking = booking._id;
                    await updatedEvent.save();
                }
            }
        }
        return updatedEvent;
    },

    // Delete event (soft delete)
    async deleteEvent(id) {
        const event = await Event.findByIdAndUpdate(
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
        if (!event) {
            throw new Error('Event not found');
        }
        await this.releaseVenueForEvent(event);
        return { message: 'Event deleted successfully', event };
    },

    // Cancel event with automatic refunds
    async cancelEvent(id, reason = 'Event cancelled by organizer') {
        const refundService = require('./refundService');
        const notificationService = require('./notificationService');
        
        const event = await Event.findById(id);
        if (!event) {
            throw new Error('Event not found');
        }

        if (event.status === 'cancelled') {
            throw new Error('Event is already cancelled');
        }

        // Update event status
        event.status = 'cancelled';
        event.cancelledAt = new Date();
        event.cancellationReason = reason;
        event.isDeleted = true;
        event.deletedAt = new Date();
        event.isActive = false;
        event.currentAttendees = 0;
        await event.save();
        await this.releaseVenueForEvent(event);

        // Process refunds for all ticket holders
        let refundResults = null;
        try {
            refundResults = await refundService.initiateEventCancellationRefunds(id, reason);
            console.log(`✅ Event cancellation refunds: ${refundResults.successCount}/${refundResults.totalRefunds} processed`);
        } catch (error) {
            console.error('❌ Error processing event cancellation refunds:', error.message);
        }

        return {
            event,
            refundResults
        };
    },

    /**
     * Whether `code` opens ticket sales for this event. A public event needs no
     * code. Compared in constant time; case-insensitive (codes are generated in
     * upper case). Throws 'Event not found' for a missing event.
     */
    async checkPrivateCode(eventId, code) {
        const event = require('mongoose').isValidObjectId(eventId)
            ? await Event.findById(eventId).select('eventType privateCode').lean()
            : null;
        if (!event) throw new Error('Event not found');
        if (event.eventType !== 'private') return true;
        if (!event.privateCode || typeof code !== 'string') return false;
        const a = Buffer.from(event.privateCode.toUpperCase());
        const b = Buffer.from(code.trim().toUpperCase());
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    },

    // Request private event access
    async requestPrivateAccess(eventId, { userId, accessCode, message }) {
        const event = await Event.findById(eventId);
        if (!event) {
            throw new Error('Event not found');
        }
        if (event.eventType !== 'private') {
            throw new Error('This is not a private event');
        }
        if (event.privateCode !== accessCode) {
            throw new Error('Invalid access code');
        }

        const request = await PrivateEventAccess.create({
            user: userId,
            event: eventId,
            accessCode,
            requestMessage: message
        });

        return request;
    },

    // Get events by organizer (User ID)
    // Public surface (a brand page): public events only.
    async getEventsByOrganizer(userId, limit = 10) {
        const events = await Event.find({ organizer: userId, status: { $ne: 'cancelled' }, eventType: 'public' })
            .select('-privateCode')
            .populate('venue', 'name address images')
            // startDateTime, not `date`: the schema has no `date` path, so this sort
            // was a no-op and the list came back in Mongo's natural order.
            .sort({ startDateTime: 1 })
            .limit(parseInt(limit))
            .lean();
        return events;
    },

    // Handle access request
    // Only the event's organizer (or an admin) may decide, and only for a request
    // that belongs to that event - this was open to anyone, so a requester could
    // approve their own way into a private event.
    /**
     * @param {string} requestId
     * @param {string} status
     * @param {{ eventId?: any, actorId?: any, isAdmin?: boolean }} [options]
     */
    async handleAccessRequest(requestId, status, { eventId, actorId, isAdmin = false } = {}) {
        if (!['approved', 'rejected'].includes(status)) {
            throw new Error('Status must be approved or rejected');
        }
        const existing = await PrivateEventAccess.findById(requestId).select('event');
        if (!existing || (eventId && String(existing.event) !== String(eventId))) {
            throw new Error('Access request not found');
        }
        if (!isAdmin) {
            const event = await Event.findById(existing.event).select('organizer');
            if (!event || String(event.organizer) !== String(actorId)) {
                const err = new Error('Only the event organizer can respond to access requests');
                err.status = 403;
                throw err;
            }
        }

        const request = await PrivateEventAccess.findByIdAndUpdate(
            requestId,
            {
                $set: {
                    status,
                    respondedAt: new Date()
                }
            },
            { new: true }
        );
        if (!request) {
            throw new Error('Access request not found');
        }
        return request;
    },

    // Venue owner approves/rejects event
    async venueApproveEvent(eventId, venueOwnerId, { status, rejectionReason }) {
        const Venue = require('../models/Venue');
        const Notification = require('../models/Notification');

        if (!['approved', 'rejected'].includes(status)) {
            throw new Error('Status must be approved or rejected');
        }

        const event = await Event.findById(eventId).populate('venue');
        if (!event) {
            throw new Error('Event not found');
        }

        // Verify venue ownership. venueOwnerId is the authenticated caller - the
        // route no longer takes it from the request body.
        if (!event.venue || !event.venue.owner || event.venue.owner.toString() !== String(venueOwnerId)) {
            const err = new Error('You do not own this venue');
            err.status = 403;
            throw err;
        }

        event.venueApproval = {
            status,
            respondedAt: new Date(),
            respondedBy: venueOwnerId,
            rejectionReason: status === 'rejected' ? rejectionReason : undefined
        };

        // If venue rejected, update event status
        if (status === 'rejected') {
            event.status = 'rejected';
            await this.releaseVenueForEvent(event);
        }
        // If both approved, set to approved
        else if (status === 'approved' && event.adminApproval?.status === 'approved') {
            event.status = 'approved';

            // Mark event dates as booked in venue daySlots
            await this.updateVenueAvailability(event);

            // Create booking automatically
            const booking = await this.createBookingForEvent(event);
            if (booking) {
                event.booking = booking._id;
            }
        }

        await event.save();

        // Notify organizer
        await Notification.create({
            user: event.organizer,
            title: status === 'approved' ? 'Venue Approved Your Event' : 'Venue Rejected Your Event',
            message: status === 'approved'
                ? `The venue has approved your event "${event.name}". Waiting for admin approval.`
                : `The venue has rejected your event "${event.name}". Reason: ${rejectionReason || 'Not specified'}`,
            type: 'system',
            data: { referenceId: event._id, referenceModel: 'Event' }
        });

        return event;
    },

    // Admin approves/rejects event
    async adminApproveEvent(eventId, adminId, { status, rejectionReason }) {
        const Notification = require('../models/Notification');

        if (!['approved', 'rejected'].includes(status)) {
            throw new Error('Status must be approved or rejected');
        }

        const event = await Event.findById(eventId);
        if (!event) {
            throw new Error('Event not found');
        }

        event.adminApproval = {
            status,
            respondedAt: new Date(),
            respondedBy: adminId,
            rejectionReason: status === 'rejected' ? rejectionReason : undefined
        };

        // If admin rejected, update event status
        if (status === 'rejected') {
            event.status = 'rejected';
            await this.releaseVenueForEvent(event);
        }
        // If admin approved, set to approved (backward compat: if venueApproval not set, consider it approved)
        else if (status === 'approved') {
            const venueApproved = !event.venueApproval || event.venueApproval.status === 'approved' || !event.venueApproval.status;
            if (venueApproved) {
                event.status = 'approved';

                // Mark event dates as booked in venue daySlots
                await this.updateVenueAvailability(event);

                // Create booking automatically
                const booking = await this.createBookingForEvent(event);
                if (booking) {
                    event.booking = booking._id;
                }
            }
        }

        await event.save();

        // Notify organizer
        await Notification.create({
            user: event.organizer,
            title: status === 'approved' ? 'Event Approved by Admin' : 'Event Rejected by Admin',
            message: status === 'approved'
                ? `Your event "${event.name}" has been approved and is now live!`
                : `Your event "${event.name}" was rejected by admin. Reason: ${rejectionReason || 'Not specified'}`,
            type: 'system',
            data: { referenceId: event._id, referenceModel: 'Event' }
        });

        // If event is approved, notify brand followers
        console.log(`🔍 Debug: Admin status=${status}, Event status=${event.status}, Organizer=${event.organizer}`);
        if (status === 'approved' && event.status === 'approved') {
            console.log('✅ Event fully approved, checking for brand profile...');
            try {
                const BrandProfile = require('../models/BrandProfile');
                const notificationService = require('./notificationService');

                // Check if organizer has a brand profile
                const brandProfile = await BrandProfile.findOne({ user: event.organizer });
                console.log(`🔍 Brand profile found: ${brandProfile ? brandProfile.name : 'NONE'}`);
                
                if (brandProfile) {
                    // Populate event with venue for email
                    const populatedEvent = await Event.findById(event._id).populate('venue', 'name address');
                    
                    const result = await notificationService.notifyBrandFollowers(
                        brandProfile._id,
                        'brand_new_event',
                        {
                            title: `${brandProfile.name} New Event`,
                            message: `${brandProfile.name} just announced "${populatedEvent.name}"! Get your tickets now.`,
                            referenceId: populatedEvent._id,
                            referenceModel: 'Event',
                            actionUrl: `/events/${populatedEvent._id}`,
                            extra: {
                                event: {
                                    _id: populatedEvent._id,
                                    name: populatedEvent.name,
                                    date: populatedEvent.startDateTime,
                                    startDateTime: populatedEvent.startDateTime,
                                    images: populatedEvent.images,
                                    ticketPrice: populatedEvent.ticketPrice,
                                    venue: populatedEvent.venue
                                }
                            }
                        },
                        true // send email
                    );
                    console.log(`✅ Notified ${brandProfile.name}'s followers about new event:`, result);
                } else {
                    console.log('⚠️ Organizer does not have a brand profile - no followers to notify');
                }
            } catch (notifErr) {
                console.error('Failed to notify brand followers:', notifErr.message);
            }
        } else {
            console.log(`⚠️ Event not fully approved: admin status=${status}, event.status=${event.status}`);
        }

        return event;
    },

    // Get events pending venue approval (for venue owners)
    async getVenueEventRequests(venueOwnerId, query = {}) {
        const Venue = require('../models/Venue');
        const { page = 1, limit = 10, status = 'pending' } = query;

        // Get venues owned by this user
        const venues = await Venue.find({ owner: venueOwnerId }).select('_id');
        const venueIds = venues.map(v => v._id);

        const filter = {
            venue: { $in: venueIds },
            'venueApproval.status': status
        };

        const events = await Event.find(filter)
            .populate('organizer', 'name email avatar verificationBadge')
            .populate('venue', 'name address images')
            .limit(parseInt(limit))
            .skip((parseInt(page) - 1) * parseInt(limit))
            .sort({ createdAt: -1 })
            .lean();

        const total = await Event.countDocuments(filter);

        return {
            events,
            totalPages: Math.ceil(total / parseInt(limit)),
            currentPage: parseInt(page),
            total
        };
    },

    // Get events pending admin approval
    async getPendingAdminApproval(query = {}) {
        const { page = 1, limit = 10, status = 'pending' } = query;

        // Show all events that need admin review
        // Events are pending if they're not already approved/cancelled/rejected
        // Exclude venue-less events so they aren't counted/listed as pending (8.1).
        const filter = {
            venue: { $exists: true, $ne: null },
            status: { $nin: ['approved', 'cancelled', 'rejected', 'blocked'] },
            $or: [
                { 'adminApproval.status': { $ne: 'approved' } },
                { 'adminApproval.status': { $exists: false } },
                { adminApproval: { $exists: false } }
            ]
        };

        const events = await Event.find(filter)
            .populate('organizer', 'name email avatar verificationBadge')
            .populate('venue', 'name address images owner')
            .limit(parseInt(limit))
            .skip((parseInt(page) - 1) * parseInt(limit))
            .sort({ createdAt: -1 })
            .lean();

        const total = await Event.countDocuments(filter);

        return {
            events,
            totalPages: Math.ceil(total / parseInt(limit)),
            currentPage: parseInt(page),
            total
        };
    },

    // Helper: mark every day the event spans as booked on its venue, when the
    // event is approved. The blockedDates slot carries the event id so
    // releaseVenueForEvent can take exactly this event's slots off again.
    async updateVenueAvailability(event) {
        const Venue = require('../models/Venue');
        const { dayKey } = require('../utils/venueAvailability');

        if (!event.venue) return;

        const venueId = event.venue._id || event.venue;
        const venue = await Venue.findById(venueId);
        if (!venue) return;

        // Ensure arrays exist to avoid runtime errors on older docs
        if (!Array.isArray(venue.daySlots)) venue.daySlots = [];
        if (!Array.isArray(venue.blockedDates)) venue.blockedDates = [];

        const days = eventVenueDays(event);
        console.log(`[updateVenueAvailability] Event: ${event.name}, Dates to book:`, days.map(d => d.key));

        for (const { key, startTime, endTime } of days) {
            // daySlots dates are stored at UTC midnight, so the toISOString day
            // every reader takes from them is this day.
            const existingSlot = venue.daySlots.find(slot => dayKey(slot.date) === key);
            if (existingSlot) {
                existingSlot.isAvailable = false;
                existingSlot.isBooked = true;
                existingSlot.bookedBy = event.organizer;
            } else {
                venue.daySlots.push({
                    date: new Date(`${key}T00:00:00Z`),
                    isAvailable: false,
                    isBooked: true,
                    bookedBy: event.organizer
                });
            }

            let entry = venue.blockedDates.find(blocked => blocked.date === key);
            if (!entry) {
                venue.blockedDates.push({ date: key, slots: [] });
                entry = venue.blockedDates[venue.blockedDates.length - 1];
            }
            if (!entry.slots.some(s => s.event && String(s.event) === String(event._id))) {
                entry.slots.push({ startTime, endTime, type: 'booked', event: event._id });
            }
        }

        await venue.save({ validateModifiedOnly: true });
    },

    /**
     * Undo updateVenueAvailability, and cancel the venue booking made for the
     * event, once the event no longer takes place there (cancelled, deleted,
     * rejected, moved). Nothing did this, so a cancelled event kept its days
     * marked booked for good and nobody could book them. Best-effort: the
     * caller's change to the event already stands.
     */
    async releaseVenueForEvent(event) {
        try {
            const Venue = require('../models/Venue');
            const Booking = require('../models/Booking');
            const { dayKey } = require('../utils/venueAvailability');
            const venueId = event.venue?._id || event.venue;
            if (!venueId) return;

            await Booking.updateMany(
                { event: event._id, status: { $in: ['pending', 'accepted'] } },
                { $set: { status: 'cancelled', cancellationReason: 'event_cancelled' } }
            );

            const venue = await Venue.findById(venueId);
            if (!venue) return;
            const days = eventVenueDays(event);
            const keys = new Set(days.map(d => d.key));
            const organizer = String(event.organizer?._id || event.organizer);
            const eventId = String(event._id);

            venue.daySlots = (venue.daySlots || []).filter(slot =>
                !(slot.isBooked && !slot.bookingId && keys.has(dayKey(slot.date)) && String(slot.bookedBy) === organizer));

            for (const entry of venue.blockedDates || []) {
                if (!keys.has(entry.date) || !Array.isArray(entry.slots)) continue;
                const legacyTimes = days.filter(d => d.key === entry.date).flatMap(d => d.legacyTimes);
                entry.slots = entry.slots.filter(slot => {
                    if (slot.event) return String(slot.event) !== eventId;
                    if (slot.type !== 'booked' || slot.booking) return true;
                    // Written before slots carried the event id: matched by time.
                    return !legacyTimes.some(t => t.startTime === slot.startTime && t.endTime === slot.endTime);
                });
            }
            venue.blockedDates = (venue.blockedDates || []).filter(d => !keys.has(d.date) || (d.slots && d.slots.length > 0));
            await venue.save({ validateModifiedOnly: true });
        } catch (err) {
            console.error(`Failed to release venue days for event ${event._id}:`, err.message);
        }
    },

    // Generate a 12-character alphanumeric code using crypto
    generateAccessCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const bytes = crypto.randomBytes(12);
        let code = '';
        for (let i = 0; i < 12; i++) {
            code += chars[bytes[i] % chars.length];
        }
        return code;
    },

    /**
     * Create scanning codes for an event (max 20 total per event).
     *
     * `entries` accepts either plain label strings (the original shape) or
     * `{ label, ticketTier }` objects. A ticketTier scopes the resulting scanner to
     * one tier, so a door handed the VIP link cannot admit a general ticket - which
     * is the only thing that made separate links mean anything. An empty tier keeps
     * the old behaviour: admits every tier for this event.
     */
    async createScanningCodes(eventId, entries = [], organizerId) {
        const event = await Event.findById(eventId);
        if (!event) {
            throw new Error('Event not found');
        }
        if (event.organizer.toString() !== organizerId.toString()) {
            throw new Error('Only the event organizer can create scanning codes');
        }

        // Normalise both accepted shapes into one. `allTiers` marks the intentional
        // combined link (empty tier, but kept through the unscoped-link sweep).
        const requested = (entries.length ? entries : ['']).map(entry =>
            typeof entry === 'string'
                ? { label: entry, ticketTier: '', allTiers: false }
                : { label: entry?.label || '', ticketTier: entry?.ticketTier || '', allTiers: entry?.allTiers === true }
        );

        // A tier that does not exist on the event would produce a scanner that
        // rejects every ticket - a door that silently admits nobody is worse than
        // an error at creation time.
        const tierNames = (event.ticketTiers || []).map(t => t.name);
        for (const { ticketTier } of requested) {
            if (ticketTier && !tierNames.includes(ticketTier)) {
                throw new Error(`"${ticketTier}" is not a ticket tier on this event`);
            }
        }

        const existingCount = await ScanningCode.countDocuments({ event: eventId });
        if (existingCount + requested.length > 20) {
            throw new Error(`Cannot exceed 20 scanning codes per event. Currently ${existingCount} exist, requested ${requested.length}.`);
        }

        const codes = [];
        for (const { label, ticketTier, allTiers } of requested) {
            let code;
            let attempts = 0;
            // Ensure uniqueness — retry if collision (extremely unlikely with 12 chars)
            while (attempts < 5) {
                code = this.generateAccessCode();
                const exists = await ScanningCode.findOne({ code });
                if (!exists) break;
                attempts++;
            }
            if (attempts >= 5) {
                throw new Error('Failed to generate unique code');
            }

            const scanningCode = await ScanningCode.create({
                event: eventId,
                code,
                // Default the label to the tier, or name the combined link so it is
                // never unnamed in the list.
                label: label || ticketTier || (allTiers ? 'All Tiers' : ''),
                ticketTier,
                allTiers,
                createdBy: organizerId
            });
            codes.push(scanningCode);
        }

        return codes;
    },

    /**
     * Pull the human ticket reference out of whatever the scanner sent.
     *
     * A ticket QR encodes a JSON payload, so the raw decoded text is the whole
     * object, not an id. Manual entry at the door sends the bare `TKT-...` string.
     * Both are accepted; anything else returns null.
     *
     * Only `ticketId` is taken from the payload. The tier and event it also carries
     * are the buyer's own printable copy and are never trusted here - a QR is
     * client-supplied data, so it could claim any tier. Everything the gate decides
     * on is re-read from the ticket record below.
     */
    parseScannedTicket(scanned) {
        if (typeof scanned !== 'string') return null;
        const raw = scanned.trim();
        if (!raw) return null;
        if (raw.startsWith('{')) {
            try {
                const parsed = JSON.parse(raw);
                return typeof parsed?.ticketId === 'string' ? parsed.ticketId.trim() : null;
            } catch {
                return null;
            }
        }
        return raw;
    },

    /**
     * Make sure every ticket tier on this event has a live scanner link, then return
     * all of the event's codes.
     *
     * Provisioned on read rather than behind a "Generate" button: a tier always needs
     * a door, so making the organiser ask for one was a step with no decision in it.
     * Tiers added by a later edit get their link the next time this is read, and
     * events with no tiers get a single all-tiers link.
     *
     * Idempotent - a tier with an active code is left alone. A tier whose only code
     * was deactivated is re-provisioned, which is what revoking a leaked link should
     * do: the old one stays dead and on the record, a fresh one takes its place.
     */
    async listScanningCodes(eventId, organizerId) {
        const event = await Event.findById(eventId);
        if (!event) {
            throw new Error('Event not found');
        }
        if (event.organizer.toString() !== organizerId.toString()) {
            throw new Error('Only the event organizer can view scanning codes');
        }

        const tierNames = (event.ticketTiers || []).map(t => t.name).filter(Boolean);

        /*
         * Retire STRAY unscoped links - ones with an empty tier that are NOT the
         * intentional combined link (allTiers !== true).
         *
         * A stray unscoped link exists only because it was generated before tier
         * scoping, and left live it is a way round the per-tier links. The one
         * combined link the organiser is meant to have carries allTiers:true and is
         * excluded here, so this sweep no longer kills it.
         *
         * `$ne: true` covers both false and the absent field on legacy documents.
         */
        await ScanningCode.updateMany(
            { event: eventId, isActive: true, ticketTier: { $in: ['', null] }, allTiers: { $ne: true } },
            { $set: { isActive: false } }
        );

        const existing = await ScanningCode.find({ event: eventId });
        const activeTiers = new Set(existing.filter(c => c.isActive && !c.allTiers).map(c => c.ticketTier));
        const hasActiveCombined = existing.some(c => c.isActive && c.allTiers);

        /*
         * Every event gets one combined "All Tiers" link PLUS a link per tier.
         *
         * The combined link admits any tier (ticketTier ''), for a single door that
         * lets everyone in; the per-tier links scope entry to one tier each. The
         * organiser chooses which to hand out. A tier is compulsory at creation now,
         * so tierNames is non-empty for new events; older tier-less events fall back
         * to PURCHASE_FALLBACK_TIER, the name their tickets were actually issued under.
         */
        const wantedTiers = tierNames.length > 0 ? tierNames : [PURCHASE_FALLBACK_TIER];

        const toCreate = [];
        if (!hasActiveCombined) {
            toCreate.push({ label: 'All Tiers', ticketTier: '', allTiers: true });
        }
        for (const name of wantedTiers) {
            if (!activeTiers.has(name)) {
                toCreate.push({ label: name, ticketTier: name, allTiers: false });
            }
        }

        if (toCreate.length > 0 && existing.length + toCreate.length <= 20) {
            await this.createScanningCodes(eventId, toCreate, organizerId);
        }

        return ScanningCode.find({ event: eventId }).sort({ createdAt: -1 });
    },

    // Validate an access code and check in a ticket
    async validateScanAndCheckIn(accessCode, scannedValue) {
        const scanningCode = await ScanningCode.findOne({ code: accessCode });
        if (!scanningCode) {
            throw new Error('Access code is invalid');
        }
        if (!scanningCode.isActive) {
            throw new Error('Access code has been deactivated');
        }

        const ticketRef = this.parseScannedTicket(scannedValue);
        if (!ticketRef) {
            throw new Error('Unreadable ticket code');
        }

        // findOne on the ticketId field, not findById. The scanner sends the
        // 'TKT-...' reference printed on the ticket, which is not the document _id -
        // findById could only ever throw a cast error on it, so no real ticket QR
        // could be checked in at all.
        const ticket = await Ticket.findOne({ ticketId: ticketRef }).populate('user', 'name email');
        if (!ticket) {
            throw new Error('Ticket not found');
        }
        if (ticket.event.toString() !== scanningCode.event.toString()) {
            throw new Error('Ticket belongs to a different event');
        }
        // A tier-scoped scanner admits only its own tier. Named in the message so the
        // person on the door knows where to send the guest instead of just "no".
        if (scanningCode.ticketTier && ticket.ticketType !== scanningCode.ticketTier) {
            throw new Error(`This scanner only admits "${scanningCode.ticketTier}" tickets. This one is "${ticket.ticketType}".`);
        }
        /*
         * An unscoped link on an event that has tiers is refused outright.
         *
         * Retiring these when the organiser views the list is not enough on its own:
         * a link already sitting in someone's browser would keep working until then,
         * and it bypasses every per-tier restriction. Checked against the event as it
         * is now, so an event that gains its first tier closes the hole immediately.
         */
        if (!scanningCode.ticketTier && !scanningCode.allTiers) {
            const event = await Event.findById(scanningCode.event).select('ticketTiers');
            if ((event?.ticketTiers || []).length > 0) {
                throw new Error('This scanner link is out of date. Ask the organiser for the link for this tier.');
            }
        }
        if (ticket.status === 'cancelled') {
            throw new Error('This ticket has been cancelled');
        }
        if (ticket.isUsed) {
            const when = ticket.usedAt ? new Date(ticket.usedAt).toLocaleString('en-IN') : 'earlier';
            throw new Error(`Ticket has already been used (${when})`);
        }

        // The condition is part of the update so that two gates scanning the same
        // QR at the same moment cannot both admit it - read-check-save let both
        // through.
        const used = await Ticket.findOneAndUpdate(
            { _id: ticket._id, isUsed: { $ne: true }, status: { $nin: ['used', 'cancelled'] } },
            { $set: { isUsed: true, usedAt: new Date(), checkedInBy: accessCode, status: 'used' } },
            { new: true }
        ).populate('user', 'name email');
        if (!used) {
            const latest = await Ticket.findById(ticket._id).select('usedAt status').lean();
            if (latest && latest.status === 'cancelled') {
                throw new Error('This ticket has been cancelled');
            }
            const when = latest && latest.usedAt ? new Date(latest.usedAt).toLocaleString('en-IN') : 'earlier';
            throw new Error(`Ticket has already been used (${when})`);
        }

        return used;
    },

    // Deactivate a scanning code (organizer only)
    async deactivateScanningCode(codeId, organizerId) {
        const scanningCode = await ScanningCode.findById(codeId);
        if (!scanningCode) {
            throw new Error('Scanning code not found');
        }
        if (scanningCode.createdBy.toString() !== organizerId.toString()) {
            throw new Error('Only the code creator can deactivate this code');
        }

        scanningCode.isActive = false;
        await scanningCode.save();
        return scanningCode;
    },

    // Helper: Create booking automatically when event is approved
    async createBookingForEvent(event) {
        const Booking = require('../models/Booking');
        const Venue = require('../models/Venue');

        if (!event.venue) return null;

        const venueId = event.venue._id || event.venue;
        const venue = await Venue.findById(venueId);

        // Check if a booking already exists for this event
        const existingBooking = await Booking.findOne({ event: event._id, status: { $in: ['pending', 'accepted'] } });
        if (existingBooking) {
            console.log(`[createBookingForEvent] Booking already exists for event ${event._id}`);
            return existingBooking;
        }

        // Calculate hours/days and pricing
        const start = new Date(event.startDateTime);
        const end = new Date(event.endDateTime);
        const durationHours = Math.ceil((end - start) / (1000 * 60 * 60)) || 1;

        let totalAmount = 0;
        if (venue) {
            const basePrice = venue.pricing?.basePrice || 0;
            const pricePerHour = venue.pricing?.pricePerHour || 0;
            totalAmount = pricePerHour > 0 ? (pricePerHour * durationHours) : basePrice;
        }

        // Helper to format time
        const formatTime = (dt) => {
            const hours = dt.getHours().toString().padStart(2, '0');
            const mins = dt.getMinutes().toString().padStart(2, '0');
            return `${hours}:${mins}`;
        };

        const bookingData = {
            user: event.organizer,
            venue: venueId,
            event: event._id,
            bookingType: 'event',
            bookingDate: start,
            startTime: formatTime(start),
            endTime: formatTime(end),
            purpose: event.description || `Event: ${event.name}`,
            expectedGuests: event.maxAttendees || 0,
            status: 'accepted',
            totalAmount: totalAmount,
            paymentStatus: 'pending'
        };

        const booking = await Booking.create(bookingData);
        console.log(`[createBookingForEvent] Created booking ${booking._id} for event ${event._id}`);
        return booking;
    }
};

module.exports = eventService;
