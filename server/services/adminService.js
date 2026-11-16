const User = require('../models/User');
const Venue = require('../models/Venue');
const Event = require('../models/Event');
const BrandProfile = require('../models/BrandProfile');
const Ticket = require('../models/Ticket');
const Booking = require('../models/Booking');
const AuditLog = require('../models/AuditLog');
const { escapeRegex } = require('../utils/escapeRegex');

/** Case-insensitive "contains" match on a user-supplied search term. */
const searchRegex = (value) => new RegExp(escapeRegex(value), 'i');

// Admin Events filters that follow the clock. `approved` and `upcoming` both
// mean "live, admin-approved"; the lifecycle job (jobs/scheduledJobs.js) moves
// them to ongoing / completed, but only when it next runs.
const LIVE_EVENT = ['approved', 'upcoming'];
const TIME_GROUPS = {
    upcoming: {
        filter: (now) => ({ status: { $in: LIVE_EVENT }, startDateTime: { $gt: now } }),
        sort: { startDateTime: 1 },
    },
    ongoing: {
        filter: (now) => ({ status: { $in: [...LIVE_EVENT, 'ongoing'] }, startDateTime: { $lte: now }, endDateTime: { $gt: now } }),
        sort: { endDateTime: 1 },
    },
    completed: {
        filter: (now) => ({
            $or: [
                { status: 'completed' },
                { status: { $in: [...LIVE_EVENT, 'ongoing'] }, endDateTime: { $lte: now } },
            ],
        }),
        sort: { endDateTime: -1 },
    },
};

// The same three groups for venue bookings, by day: bookingDate / endDate are
// UTC midnights of the local (IST) day, and endDate is null for a one-day
// booking. Only an accepted booking is confirmed, and "completed" is only ever
// set by hand, so an accepted booking whose last day has gone counts as done.
const BOOKING_LAST_DAY = (cmp, day) => ({
    $or: [{ endDate: { [cmp]: day } }, { endDate: null, bookingDate: { [cmp]: day } }],
});
const BOOKING_TIME_GROUPS = {
    upcoming: (today) => ({ status: 'accepted', bookingDate: { $gt: today } }),
    ongoing: (today) => ({ status: 'accepted', bookingDate: { $lte: today }, ...BOOKING_LAST_DAY('$gte', today) }),
    completed: (today) => ({ $or: [{ status: 'completed' }, { status: 'accepted', ...BOOKING_LAST_DAY('$lt', today) }] }),
};
function bookingToday() {
    const { localDayKey } = require('../utils/venueAvailability');
    return new Date(`${localDayKey(new Date())}T00:00:00Z`);
}

// What a paid booking has received, as an aggregation expression: the same rule
// as venueService.computeRefund (advance, plus the rest once that is paid; or
// the full amount).
const BOOKING_RECEIVED = {
    $cond: [
        { $eq: ['$paymentSchedule.type', 'installment'] },
        {
            $add: [
                { $ifNull: ['$paymentSchedule.depositAmount', 0] },
                { $cond: [{ $eq: ['$paymentSchedule.balanceStatus', 'paid'] }, { $ifNull: ['$paymentSchedule.balanceAmount', 0] }, 0] },
            ],
        },
        { $ifNull: [{ $cond: [{ $gt: ['$paymentSchedule.depositAmount', 0] }, '$paymentSchedule.depositAmount', null] }, '$totalAmount'] },
    ],
};

const adminService = {
    // ================== DASHBOARD STATS ==================
    async getStats() {
        // Required here, not at the top: identityService and refundService both
        // require this module lazily, and a top-level require would be circular.
        const identityService = require('./identityService');
        const Refund = require('../models/Refund');
        const [
            totalUsers,
            totalVenues,
            totalEvents,
            totalBrands,
            pendingVenues,
            pendingEvents,
            pendingBrands,
            blockedUsers,
            totalTickets,
            ticketRevenue,
            bookingRevenue,
            pendingRefunds,
            pendingIdChecks
        ] = await Promise.all([
            User.countDocuments(),
            // Deleted listings are excluded here so the headline counts agree
            // with what the Venues/Events tables actually show.
            Venue.countDocuments({ isDeleted: { $ne: true } }),
            Event.countDocuments({ isDeleted: { $ne: true } }),
            BrandProfile.countDocuments(),
            Venue.countDocuments({ status: 'pending', isDeleted: { $ne: true } }),
            // Exclude venue-less events from the pending count (8.1). A genuinely
            // pending event that HAS a venue still counts (preservation 3.11).
            Event.countDocuments({ status: 'pending', venue: { $exists: true, $ne: null }, isDeleted: { $ne: true } }),
            BrandProfile.countDocuments({ status: 'pending' }),
            User.countDocuments({ isBlocked: true }),
            Ticket.countDocuments(),
            Ticket.aggregate([
                { $group: { _id: null, total: { $sum: '$price' } } }
            ]),
            // Venue booking revenue: what guests have actually paid. Summing
            // totalAmount over accepted bookings counted bookings nobody had
            // paid for yet (accepting comes before paying).
            Booking.aggregate([
                { $match: { paymentStatus: 'paid' } },
                { $group: { _id: null, total: { $sum: BOOKING_RECEIVED } } }
            ]),
            // The two queues that need an admin's hand: refunds raised but not
            // yet paid, and ID documents waiting for review.
            Refund.countDocuments({ status: 'pending' }),
            identityService.countPending()
        ]);

        const ticketRev = ticketRevenue[0]?.total || 0;
        const bookingRev = bookingRevenue[0]?.total || 0;

        return {
            totalUsers,
            totalVenues,
            totalEvents,
            totalBrands,
            pendingVenues,
            pendingEvents,
            pendingBrands,
            blockedUsers,
            totalTickets,
            pendingRefunds,
            pendingIdChecks,
            totalRevenue: ticketRev + bookingRev,
            ticketRevenue: ticketRev,
            venueRevenue: bookingRev,
            trends: await adminService.getTrends(),
        };
    },

    /**
     * The last six calendar months (this one included), oldest first, for the
     * dashboard charts: new sign-ups, money collected (successful payments,
     * split into tickets and venue bookings) and tickets sold. Months with
     * nothing in them are present as zeros, so the chart always has six bars.
     * Months are counted in India time.
     */
    async getTrends(now = new Date()) {
        const Payment = require('../models/Payment');
        const TZ = 'Asia/Kolkata';
        const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
        const months = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - i, 1));
            months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
        }
        // Start of the first month in India time, as an instant.
        const [y, m] = months[0].split('-').map(Number);
        const since = new Date(Date.UTC(y, m - 1, 1) - 5.5 * 3600 * 1000);
        const monthOf = (field) => ({ $dateToString: { format: '%Y-%m', date: field, timezone: TZ } });

        const [users, payments, tickets] = await Promise.all([
            User.aggregate([
                { $match: { createdAt: { $gte: since } } },
                { $group: { _id: monthOf('$createdAt'), n: { $sum: 1 } } },
            ]),
            Payment.aggregate([
                { $match: { status: 'success', $or: [{ paidAt: { $gte: since } }, { paidAt: null, createdAt: { $gte: since } }] } },
                { $group: {
                    _id: { month: monthOf({ $ifNull: ['$paidAt', '$createdAt'] }), venue: { $eq: ['$referenceModel', 'Booking'] } },
                    total: { $sum: { $ifNull: ['$totalAmount', '$amount'] } },
                } },
            ]),
            Ticket.aggregate([
                { $match: { createdAt: { $gte: since }, status: { $ne: 'cancelled' } } },
                { $group: { _id: monthOf('$createdAt'), n: { $sum: { $ifNull: ['$quantity', 1] } } } },
            ]),
        ]);

        const pick = (rows, month) => rows.find((r) => r._id === month)?.n || 0;
        const money = (month, venue) => {
            const row = payments.find((r) => r._id.month === month && r._id.venue === venue);
            return row ? Math.round(row.total * 100) / 100 : 0;
        };
        return months.map((month) => ({
            month,
            newUsers: pick(users, month),
            ticketRevenue: money(month, false),
            venueRevenue: money(month, true),
            ticketsSold: pick(tickets, month),
        }));
    },

    // ================== USERS ==================
    async getAllUsers(query = {}) {
        const { page = 1, limit = 20, search, role, status } = query;
        const filter = {};

        if (search) {
            filter.$or = [
                { name: searchRegex(search) },
                { email: searchRegex(search) }
            ];
        }
        // `roles` is the source of truth (a user can be both user and venue_owner);
        // `role` is the legacy single field. Matching only `role` missed every
        // account whose second role is the one being filtered for.
        if (role && role !== 'all') {
            filter.$and = [...(filter.$and || []), { $or: [{ roles: role }, { role }] }];
        }
        if (status === 'blocked') filter.isBlocked = true;
        if (status === 'active') filter.isBlocked = { $ne: true };

        const users = await User.find(filter)
            .select('-password')
            .limit(parseInt(limit))
            .skip((parseInt(page) - 1) * parseInt(limit))
            .sort({ createdAt: -1 });

        const total = await User.countDocuments(filter);

        return {
            users,
            totalPages: Math.ceil(total / parseInt(limit)),
            currentPage: parseInt(page),
            total
        };
    },

    async getUserById(id) {
        const user = await User.findById(id).select('-password');
        if (!user) throw new Error('User not found');

        // Newest first, for the "Recent" lists on the admin's user page. Events
        // carry startDateTime (not `date`, which the model never had - the page
        // showed "Invalid Date"), with the venue's name populated.
        const tickets = await Ticket.find({ user: id })
            .sort({ createdAt: -1 })
            .populate({ path: 'event', select: 'name startDateTime venue', populate: { path: 'venue', select: 'name' } });
        const bookings = await Booking.find({ user: id })
            .sort({ createdAt: -1 })
            .populate('venue', 'name address');

        return {
            ...user.toObject(),
            tickets,
            bookings,
            stats: {
                totalTickets: tickets.length,
                totalBookings: bookings.length,
                totalSpent: tickets.reduce((sum, t) => sum + (t.price || 0), 0) + bookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0)
            }
        };
    },

    // ================== AUDIT WRITER ==================

    /**
     * Map a new status value onto an audit action.
     *
     * Pure, so it is checkable without a database. 'update' is the honest answer for
     * a status the action enum has no word for (back to 'pending', an event moved to
     * 'cancelled'): the specific values live in metadata either way.
     */
    actionForStatus(status) {
        return ({
            approved: 'approve',
            rejected: 'reject',
            blocked: 'block',
            unblocked: 'unblock',
            active: 'unblock',
        })[String(status || '').toLowerCase()] || 'update';
    },

    /**
     * The single place an admin action is recorded.
     *
     * Every mutating operation on this service used to decide for itself whether to
     * write an AuditLog, and only four of nine did - deleteUser, deleteVenue,
     * deleteEvent and toggleFeatured. So approving an event, rejecting a venue,
     * approving a creator and blocking a user, the decisions the trail exists for,
     * left no record at all. Routing them all through one writer is what stops the
     * next operation added here from being invisible too.
     *
     * A failed audit write is logged, not thrown: the change it describes has already
     * been committed by the time we get here, so raising would report failure for an
     * action that actually took effect and invite a double-apply on retry.
     */
    async recordAdminAction({ adminUser, action, entityType, entityId, metadata = {} }) {
        if (!adminUser) {
            // Not fatal, but it means a route forgot to pass req.user._id and the
            // entry would be unattributable - which is the one thing an audit trail
            // cannot be missing.
            console.error(`AuditLog: no adminUser for ${action} on ${entityType} ${entityId}`);
            return null;
        }
        try {
            return await AuditLog.create({ adminUser, action, entityType, entityId, metadata });
        } catch (error) {
            console.error('AuditLog write failed:', error.message);
            return null;
        }
    },

    async blockUser(userId, adminUserId) {
        const user = await User.findByIdAndUpdate(
            userId,
            { $set: { isBlocked: true } },
            { new: true }
        ).select('-password');
        if (!user) throw new Error('User not found');

        await adminService.recordAdminAction({
            adminUser: adminUserId,
            action: 'block',
            entityType: 'user',
            entityId: userId,
            // The name and email are copied in rather than left to a join: the account
            // can later be deleted, and a trail of bare ids is not reviewable.
            metadata: { name: user.name, email: user.email, field: 'isBlocked', from: false, to: true },
        });
        return user;
    },

    async unblockUser(userId, adminUserId) {
        const user = await User.findByIdAndUpdate(
            userId,
            { $set: { isBlocked: false } },
            { new: true }
        ).select('-password');
        if (!user) throw new Error('User not found');

        await adminService.recordAdminAction({
            adminUser: adminUserId,
            action: 'unblock',
            entityType: 'user',
            entityId: userId,
            metadata: { name: user.name, email: user.email, field: 'isBlocked', from: true, to: false },
        });
        return user;
    },

    // Hard-delete a user account and everything they own. Reuses
    // userService.deleteAccount so the admin path and the self-service path
    // cascade over exactly the same collections — one cascade to maintain.
    // Two guards, both to prevent an irreversible loss of access: an admin
    // cannot delete themselves, and no admin account can be deleted from the
    // dashboard at all (remove the admin role first, then delete).
    // Pure guard, exported so it can be checked without a database.
    // Returns null when the delete is allowed, else { status, message }.
    userDeleteBlockReason(target, userId, adminUserId) {
        if (String(userId) === String(adminUserId)) {
            return { status: 400, message: 'You cannot delete your own account' };
        }
        const targetIsAdmin = target.role === 'admin'
            || (Array.isArray(target.roles) && target.roles.includes('admin'));
        if (targetIsAdmin) {
            return { status: 403, message: 'Admin accounts cannot be deleted. Remove the admin role first.' };
        }
        return null;
    },

    async deleteUser(userId, adminUserId) {
        const target = await User.findById(userId).select('role roles');
        if (!target) throw new Error('User not found');

        const blocked = this.userDeleteBlockReason(target, userId, adminUserId);
        if (blocked) throw Object.assign(new Error(blocked.message), { status: blocked.status });

        // Name/email captured before the cascade - after it there is no account left
        // to join against, so an id-only entry would be permanently unreadable.
        const named = await User.findById(userId).select('name email').lean();
        const result = await require('./userService').deleteAccount(userId);
        await adminService.recordAdminAction({
            adminUser: adminUserId,
            action: 'delete',
            entityType: 'user',
            entityId: userId,
            metadata: { name: named?.name, email: named?.email },
        });
        return result;
    },

    // ================== VENUES ==================
    async getVenues(query = {}) {
        const { page = 1, limit = 20, search, status } = query;
        // Soft-deleted venues are gone as far as the dashboard is concerned;
        // the audit trail is the record that they existed.
        const filter = { isDeleted: { $ne: true } };

        if (search) {
            filter.$or = [
                { name: searchRegex(search) },
                { 'address.city': searchRegex(search) }
            ];
        }
        // The status route stores 'blocked'; the Venue model's own word is
        // 'suspended'. Both mean the same to an admin, so Blocked lists both.
        if (status === 'blocked') filter.status = { $in: ['blocked', 'suspended'] };
        else if (status && status !== 'all') filter.status = status;

        const venues = await Venue.find(filter)
            // govIdStatus: a venue cannot be approved until its owner's ID is
            // verified, so the list shows it beside the owner.
            .populate('owner', 'name email govIdStatus')
            .limit(parseInt(limit))
            .skip((parseInt(page) - 1) * parseInt(limit))
            .sort({ createdAt: -1 });

        const total = await Venue.countDocuments(filter);

        return {
            venues,
            totalPages: Math.ceil(total / parseInt(limit)),
            currentPage: parseInt(page),
            total
        };
    },

    // Every venue booking in one list, so an admin can see what is booked and
    // paid without opening each venue. `search` matches the venue name or the
    // guest's name/email; `venue` narrows to one venue. `received` is what the
    // guest has actually paid so far (the same figure a cancellation refunds
    // against), not the booking's price.
    async getBookings(query = {}) {
        const { page = 1, limit = 20, search, status, paymentStatus, venue } = query;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
        const filter = {};

        if (venue) {
            const mongoose = require('mongoose');
            if (!mongoose.isValidObjectId(venue)) {
                return { bookings: [], counts: {}, totalPages: 0, currentPage: pageNum, total: 0 };
            }
            // An ObjectId, not the string: the counts below go through aggregate,
            // which does not cast.
            filter.venue = new mongoose.Types.ObjectId(String(venue));
        }
        if (search) {
            const [venueIds, userIds] = await Promise.all([
                Venue.find({ name: searchRegex(search) }).distinct('_id'),
                User.find({ $or: [{ name: searchRegex(search) }, { email: searchRegex(search) }] }).distinct('_id'),
            ]);
            filter.$or = [{ venue: { $in: venueIds } }, { user: { $in: userIds } }];
        }
        // Counts per status for the filter chips, before the status filter itself.
        const countRows = await Booking.aggregate([
            { $match: filter },
            { $group: { _id: '$status', n: { $sum: 1 } } },
        ]);
        const counts = Object.fromEntries(countRows.map((r) => [r._id, r.n]));
        counts.all = countRows.reduce((sum, r) => sum + r.n, 0);
        const today = bookingToday();
        const withGroup = (group) => ({ ...filter, $and: [...(filter.$and || []), BOOKING_TIME_GROUPS[group](today)] });
        const [upcoming, ongoing, completed] = await Promise.all(
            ['upcoming', 'ongoing', 'completed'].map((g) => Booking.countDocuments(withGroup(g)))
        );
        Object.assign(counts, { upcoming, ongoing, completed });

        let sort = { createdAt: -1 };
        if (status && BOOKING_TIME_GROUPS[status]) {
            Object.assign(filter, withGroup(status));
            sort = status === 'completed' ? { bookingDate: -1 } : { bookingDate: 1 };
        } else if (status && status !== 'all') {
            filter.status = status;
        }
        if (paymentStatus && paymentStatus !== 'all') filter.paymentStatus = paymentStatus;

        const [rows, total] = await Promise.all([
            Booking.find(filter)
                .select('venue user bookingDate endDate startTime endTime status paymentStatus totalAmount paymentSchedule expectedGuests createdAt')
                .populate({ path: 'venue', select: 'name address.city owner', populate: { path: 'owner', select: 'name email' } })
                .populate('user', 'name email phone')
                .sort(sort)
                .skip((pageNum - 1) * limitNum)
                .limit(limitNum)
                .lean(),
            Booking.countDocuments(filter),
        ]);

        const { computeRefund } = require('./venueService');
        const bookings = rows.map((b) => ({
            ...b,
            received: b.paymentStatus === 'paid' ? computeRefund(b.paymentSchedule, b.totalAmount, 0).amountPaid : 0,
        }));

        return {
            bookings,
            counts,
            totalPages: Math.ceil(total / limitNum),
            currentPage: pageNum,
            total,
        };
    },

    // Venue owners with their venues + bank details (admin-only read — this
    // router is gated behind adminAuth, so surfacing bankDetails here is safe).
    // Flow 8.6: list venue owners, expandable to their venues, with the owner's
    // stored payout bank details visible to admins.
    async getVenueOwners(query = {}) {
        const { search } = query;

        // Group venues by owner so we don't fan out one query per owner.
        const venues = await Venue.find({ isDeleted: { $ne: true } })
            .select('name status address capacity owner createdAt')
            .sort({ createdAt: -1 });

        const ownerIds = [...new Set(venues.map((v) => String(v.owner)).filter(Boolean))];
        if (ownerIds.length === 0) return { owners: [] };

        const ownerFilter = { _id: { $in: ownerIds } };
        if (search) {
            ownerFilter.$or = [
                { name: searchRegex(search) },
                { email: searchRegex(search) }
            ];
        }

        // bankDetails is intentionally selected — admin-only read (Flow 8.6).
        const owners = await User.find(ownerFilter)
            .select('name email phone role roles adminRole bankDetails govIdStatus');

        const venuesByOwner = venues.reduce((acc, v) => {
            const key = String(v.owner);
            (acc[key] = acc[key] || []).push(v);
            return acc;
        }, {});

        return {
            owners: owners.map((o) => ({
                ...o.toObject(),
                venues: venuesByOwner[String(o._id)] || []
            }))
        };
    },

    /**
     * Everyone who has organised an event, with their events. The organiser
     * counterpart of getVenueOwners: PAN status (event earnings are paid out
     * only once it is verified), bank details (admin-only read, Flow 8.6),
     * creator profile and verified badge.
     */
    async getEventOrganisers(query = {}) {
        const { search } = query;
        const events = await Event.find({ isDeleted: { $ne: true }, organizer: { $ne: null } })
            .select('name status startDateTime endDateTime currentAttendees maxAttendees organizer eventType createdAt')
            .sort({ startDateTime: -1 })
            .lean();
        const organiserIds = [...new Set(events.map((e) => String(e.organizer)).filter(Boolean))];
        if (organiserIds.length === 0) return { organisers: [] };

        const filter = { _id: { $in: organiserIds } };
        if (search) filter.$or = [{ name: searchRegex(search) }, { email: searchRegex(search) }];

        const [people, brands] = await Promise.all([
            User.find(filter)
                .select('name email phone isVerified verificationBadge panStatus bankDetails isBlocked createdAt')
                .lean(),
            BrandProfile.find({ user: { $in: organiserIds } }).select('name user status').lean(),
        ]);
        const brandByUser = new Map(brands.map((b) => [String(b.user), b]));
        const eventsBy = events.reduce((acc, e) => {
            (acc[String(e.organizer)] = acc[String(e.organizer)] || []).push(e);
            return acc;
        }, {});
        const LIVE = ['approved', 'upcoming', 'ongoing'];

        const organisers = people.map((p) => {
            const list = eventsBy[String(p._id)] || [];
            const brand = brandByUser.get(String(p._id));
            return {
                ...p,
                panStatus: p.panStatus || 'none',
                brand: brand ? { _id: brand._id, name: brand.name, status: brand.status } : null,
                events: list,
                counts: {
                    total: list.length,
                    live: list.filter((e) => LIVE.includes(e.status)).length,
                    pending: list.filter((e) => e.status === 'pending').length,
                    completed: list.filter((e) => e.status === 'completed').length,
                    ticketsSold: list.reduce((n, e) => n + (e.currentAttendees || 0), 0),
                },
            };
        });
        // Busiest first.
        organisers.sort((a, b) => b.counts.total - a.counts.total || String(a.name).localeCompare(String(b.name)));
        return { organisers };
    },

    async getVenueById(id) {
        // govIdStatus: the venue cannot be approved until the owner's ID is verified.
        const venue = await Venue.findById(id).populate('owner', 'name email phone bankDetails govIdStatus');
        if (!venue) throw new Error('Venue not found');

        // Get booking stats
        const bookings = await Booking.find({ venue: id });
        // What guests have paid, not the price of every booking ever requested.
        const { computeRefund } = require('./venueService');
        const totalRevenue = bookings.reduce((sum, b) => sum + (b.paymentStatus === 'paid'
            ? computeRefund(b.paymentSchedule, b.totalAmount, 0).amountPaid
            : 0), 0);

        return {
            ...venue.toObject(),
            stats: {
                totalBookings: bookings.length,
                totalRevenue,
                completedBookings: bookings.filter(b => b.status === 'completed').length
            }
        };
    },

    async updateVenueStatus(venueId, status, adminUserId) {
        // Read the old status first so the trail can show what changed, not just what
        // it ended up as. "approved" on its own does not tell a reviewer whether this
        // was a first approval or a reversal of a rejection.
        const before = await Venue.findById(venueId).select('status name owner').lean();
        if (!before) throw new Error('Venue not found');

        // A venue goes public only once a person has checked who owns it. Venues
        // already approved stay approved; this guards the move into 'approved'.
        if (status === 'approved' && before.status !== 'approved') {
            const identityService = require('./identityService');
            if (!(await identityService.isVerified(before.owner, 'gov-id'))) {
                throw new Error(`Verify the owner's government ID before approving "${before.name}" (Venue Owners or ID Checks).`);
            }
        }

        const venue = await Venue.findByIdAndUpdate(
            venueId,
            { $set: { status } },
            { new: true }
        );
        if (!venue) throw new Error('Venue not found');

        await adminService.recordAdminAction({
            adminUser: adminUserId,
            action: adminService.actionForStatus(status),
            entityType: 'venue',
            entityId: venueId,
            metadata: { name: before.name, field: 'status', from: before.status, to: status },
        });

        // Tell the owner. Only on a real change; wording follows where it went.
        if (before.status !== status) {
            const wasHidden = ['blocked', 'suspended'].includes(before.status);
            const text = {
                approved: wasHidden
                    ? { title: 'Your venue is visible again', message: `"${before.name}" has been unblocked and is listed on FIRA again.` }
                    : { title: 'Your venue is live', message: `"${before.name}" was approved and is now listed on FIRA.` },
                rejected: { title: 'Your venue was not approved', message: `"${before.name}" was not approved. Contact FIRA support to find out what to change.` },
                blocked: { title: 'Your venue was blocked', message: `"${before.name}" was blocked by FIRA and is hidden from the site. Only FIRA can unblock it - please contact FIRA support.` },
                pending: { title: 'Your venue is back in review', message: `"${before.name}" is being reviewed again by FIRA.` },
            }[status];
            if (text) {
                await adminService.notifyUser(before.owner, {
                    ...text,
                    data: { referenceId: venueId, referenceModel: 'Venue', actionUrl: '/venue-portal/venues' },
                });
            }
        }
        return venue;
    },

    // Delist a venue. Reuses the owner-facing soft delete (isDeleted +
    // isActive:false) so bookings, payouts and reconciliation figures stay
    // queryable — a hard delete here would silently break earnings totals.
    // Removing a venue with live events at it is refused - those events (and the
    // tickets sold for them) have to be dealt with first. Its upcoming bookings
    // are cancelled and what the guests paid is raised as refunds to be done.
    async deleteVenue(venueId, adminUserId) {
        const named = await Venue.findById(venueId).select('name owner').lean();
        const removal = require('./listingRemovalService');
        const { events } = await removal.venueObligations(venueId);
        if (events.length) {
            throw Object.assign(new Error('This venue has upcoming events. Cancel or move them before removing the venue.'), { status: 409, events });
        }
        const cancelledBookings = await removal.cancelVenueBookingsForRemoval(venueId);
        const result = await require('./venueService').deleteVenue(venueId);
        await adminService.recordAdminAction({
            adminUser: adminUserId,
            action: 'delete',
            entityType: 'venue',
            entityId: venueId,
            metadata: { name: named?.name, cancelledBookings },
        });
        await adminService.notifyUser(named?.owner, {
            title: 'Your venue was removed',
            message: `"${named?.name || 'Your venue'}" was removed from FIRA.${cancelledBookings ? ` Its ${cancelledBookings} upcoming booking${cancelledBookings === 1 ? ' was' : 's were'} cancelled and the guests will be refunded.` : ''} Contact FIRA support if you have questions.`,
            data: { referenceId: venueId, referenceModel: 'Venue', actionUrl: '/venue-portal/venues' },
        });
        return { ...result, cancelledBookings };
    },

    // ================== EVENTS ==================
    async getEvents(query = {}) {
        const { page = 1, limit = 20, search, status, eventType } = query;
        // Same rule as getVenues: deleted listings drop out of the dashboard.
        const filter = { isDeleted: { $ne: true } };

        if (search) {
            const matchingVenues = await Venue.find({
                $or: [
                    { name: searchRegex(search) },
                    { 'address.city': searchRegex(search) }
                ]
            }).select('_id');

            filter.$or = [
                { name: searchRegex(search) },
                { 'customVenue.city': searchRegex(search) },
                { 'customVenue.name': searchRegex(search) },
                { venue: { $in: matchingVenues.map(v => v._id) } }
            ];
        }
        // Upcoming / ongoing / completed are decided by the event's dates, not
        // by the stored word alone: approval stores `approved` and nothing ever
        // stores `upcoming`, so matching that literal listed nothing. The dates
        // also keep the groups right before the lifecycle job next runs.
        let sort = { createdAt: -1 };
        const timeGroup = status && TIME_GROUPS[status];
        if (timeGroup) {
            const now = new Date();
            filter.$and = [...(filter.$and || []), timeGroup.filter(now)];
            sort = timeGroup.sort;
        } else if (status && status !== 'all') {
            filter.status = status;
        }
        if (eventType && (eventType === 'public' || eventType === 'private')) {
            filter.eventType = eventType;
        }

        const events = await Event.find(filter)
            .populate('organizer', 'name email')
            .populate('venue', 'name address')
            .limit(parseInt(limit))
            .skip((parseInt(page) - 1) * parseInt(limit))
            .sort(sort);

        const total = await Event.countDocuments(filter);

        return {
            events,
            totalPages: Math.ceil(total / parseInt(limit)),
            currentPage: parseInt(page),
            total
        };
    },

    async getEventById(id) {
        // organizer bankDetails is an admin-only read (Flow 8.6) — this service
        // is only reachable through the adminAuth-gated router.
        const event = await Event.findById(id)
            .populate('organizer', 'name email phone bankDetails')
            .populate('venue', 'name address');
        if (!event) throw new Error('Event not found');

        // Get ticket stats
        const tickets = await Ticket.find({ event: id }).populate('user', 'name email phone');
        const totalRevenue = tickets.reduce((sum, t) => sum + (t.price || 0), 0);
        const ticketsSold = tickets.reduce((sum, t) => sum + (t.quantity || 1), 0);

        return {
            ...event.toObject(),
            tickets,
            stats: {
                ticketsSold,
                totalRevenue,
                totalBookings: tickets.length
            }
        };
    },

    async updateEventStatus(eventId, status, adminUserId) {
        const before = await Event.findById(eventId).select('status name').lean();
        if (!before) throw new Error('Event not found');

        const event = await Event.findByIdAndUpdate(
            eventId,
            { $set: { status } },
            { new: true }
        );
        if (!event) throw new Error('Event not found');

        await adminService.recordAdminAction({
            adminUser: adminUserId,
            action: adminService.actionForStatus(status),
            entityType: 'event',
            entityId: eventId,
            metadata: { name: before.name, field: 'status', from: before.status, to: status },
        });

        // Only FIRA can lift a block, so the organiser has to be told it happened
        // and who to talk to - otherwise the event just disappears on them.
        if (status === 'blocked' && before.status !== 'blocked') {
            await adminService.notifyOrganizer(event, {
                title: 'Your event was blocked',
                message: `"${event.name}" was blocked by FIRA and is hidden from the site. Only FIRA can unblock it - please contact FIRA support.`,
            });
        }
        return event;
    },

    /**
     * Lift an admin block on an event. Admin-only: organisers have no route to
     * this, so a blocked event stays blocked until FIRA decides otherwise.
     *
     * The event returns to the status it had when it was blocked, read from the
     * audit trail's block entry. Without one (blocked before the trail recorded
     * from/to), it is rebuilt from the approvals: live if both are approved,
     * otherwise back in review. A live event whose dates have since passed is
     * moved on to ongoing/completed by the lifecycle job, as for any event.
     */
    async unblockEvent(eventId, adminUserId) {
        const event = await Event.findById(eventId).select('status name organizer adminApproval venueApproval isDeleted').lean();
        if (!event) throw new Error('Event not found');
        if (event.status !== 'blocked') throw new Error('Only a blocked event can be unblocked');

        const RESTORABLE = ['pending', 'approved', 'upcoming', 'ongoing', 'completed'];
        // Skip a repeat block of an already-blocked event: its "from" is 'blocked'.
        const lastBlock = await AuditLog.findOne({ entityType: 'event', entityId: eventId, action: 'block', 'metadata.from': { $ne: 'blocked' } })
            .sort({ timestamp: -1 }).select('metadata').lean();
        const recorded = lastBlock?.metadata?.from;
        const venueOk = !event.venueApproval?.status || event.venueApproval.status === 'approved';
        const restoreTo = RESTORABLE.includes(recorded)
            ? recorded
            : (event.adminApproval?.status === 'approved' && venueOk ? 'approved' : 'pending');

        // Claimed on status so two admins unblocking at once restore it once.
        const updated = await Event.findOneAndUpdate(
            { _id: eventId, status: 'blocked' },
            { $set: { status: restoreTo } },
            { new: true }
        );
        if (!updated) throw new Error('Only a blocked event can be unblocked');

        await adminService.recordAdminAction({
            adminUser: adminUserId,
            action: 'unblock',
            entityType: 'event',
            entityId: eventId,
            metadata: { name: event.name, field: 'status', from: 'blocked', to: restoreTo },
        });
        await adminService.notifyOrganizer(updated, {
            title: 'Your event was unblocked',
            message: restoreTo === 'pending'
                ? `"${event.name}" is no longer blocked. It is back in review.`
                : `"${event.name}" is no longer blocked and is visible again.`,
        });
        return updated;
    },

    /** Best-effort message to an event's organiser; never fails the action. */
    async notifyOrganizer(event, { title, message }) {
        if (!event?.organizer) return;
        await adminService.notifyUser(event.organizer, {
            title,
            message,
            data: { referenceId: event._id, referenceModel: 'Event', actionUrl: `/dashboard/events/${event._id}` },
        });
    },

    /**
     * Tell the person an admin decision is about: inbox, phone (FCM), browser
     * push and open tabs. Best-effort - a failed notification never undoes the
     * decision. Venue owners and creators used to learn about approvals, blocks
     * and removals only by noticing them in the portal.
     */
    async notifyUser(userId, { title, message, type = 'system', data = {} }) {
        if (!userId) return;
        try {
            await require('./notificationService').createNotification({ userId, type, title, message, data, priority: 'high', channel: 'all' });
        } catch (error) {
            console.error('Admin decision notification failed:', error.message);
        }
    },

    // Delist an event. Same reasoning as deleteVenue: soft delete via the
    // existing organizer-facing path keeps tickets and revenue queryable.
    // Refunds are NOT triggered here — use the cancel flow for that.
    // An event with sold tickets is removed by cancelling it: the tickets are
    // cancelled and refunds raised in "Refunds to be done" (eventService.cancelEvent).
    // Removing it quietly left buyers holding tickets for an event that was gone.
    async deleteEvent(eventId, adminUserId) {
        const named = await Event.findById(eventId).select('name status organizer').lean();
        const eventService = require('./eventService');
        const removal = require('./listingRemovalService');
        const hadSales = named && named.status !== 'cancelled' && await removal.eventHasSales(eventId);
        const result = hadSales
            ? await eventService.cancelEvent(eventId, 'Event removed by FIRA')
            : await eventService.deleteEvent(eventId);
        await adminService.recordAdminAction({
            adminUser: adminUserId,
            action: 'delete',
            entityType: 'event',
            entityId: eventId,
            metadata: { name: named?.name, ticketsCancelled: !!hadSales },
        });
        // Ticket holders hear about their refunds from the cancellation; the
        // organiser has to be told why their event disappeared.
        await adminService.notifyUser(named?.organizer, {
            title: 'Your event was removed',
            message: `"${named?.name || 'Your event'}" was removed from FIRA.${hadSales ? ' The tickets sold were cancelled and the buyers will be refunded.' : ''} Contact FIRA support if you have questions.`,
            data: { referenceId: eventId, referenceModel: 'Event', actionUrl: '/dashboard/events' },
        });
        return result;
    },

    async toggleFeatured(eventId, isFeatured, adminUserId) {
        const event = await Event.findById(eventId);
        if (!event) throw new Error('Event not found');

        if (!['approved', 'upcoming'].includes(event.status)) {
            throw new Error('Event must be in approved or upcoming status to be featured');
        }

        const was = Boolean(event.isFeatured);
        event.isFeatured = isFeatured;
        await event.save();

        await adminService.recordAdminAction({
            adminUser: adminUserId,
            action: isFeatured ? 'feature' : 'unfeature',
            entityType: 'event',
            entityId: eventId,
            metadata: { name: event.name, field: 'isFeatured', from: was, to: Boolean(isFeatured) },
        });

        return event;
    },

    // ================== BRANDS ==================
    async getBrands(query = {}) {
        const { page = 1, limit = 20, search, status } = query;
        const filter = {};

        if (search) {
            filter.name = searchRegex(search);
        }
        if (status && status !== 'all') filter.status = status;

        const brands = await BrandProfile.find(filter)
            .populate('user', 'name email isVerified verificationBadge')
            .limit(parseInt(limit))
            .skip((parseInt(page) - 1) * parseInt(limit))
            .sort({ createdAt: -1 })
            .lean();

        const total = await BrandProfile.countDocuments(filter);

        // Live events count per brand, batched into ONE aggregation keyed by
        // organiser rather than a count per row. stats.events on the document is
        // never maintained (approving an event does not bump it), so the admin
        // list read 0 for everyone; this reflects the real number.
        const ownerIds = brands.map(b => b.user?._id).filter(Boolean);
        const counts = ownerIds.length
            ? await Event.aggregate([
                {
                    $match: {
                        organizer: { $in: ownerIds },
                        isDeleted: { $ne: true },
                        status: { $in: ['approved', 'upcoming', 'ongoing', 'completed'] },
                    },
                },
                { $group: { _id: '$organizer', count: { $sum: 1 } } },
            ])
            : [];
        const countByOwner = new Map(counts.map(c => [String(c._id), c.count]));

        const shaped = brands.map(b => ({
            ...b,
            // Flattened aliases the admin table reads directly, so the column does
            // not have to reach through `.user`/`.stats` (and previously read the
            // wrong field names, showing N/A and 0).
            owner: b.user,
            followersCount: b.stats?.followers || 0,
            eventsCount: countByOwner.get(String(b.user?._id)) || 0,
        }));

        return {
            brands: shaped,
            totalPages: Math.ceil(total / parseInt(limit)),
            currentPage: parseInt(page),
            total
        };
    },

    async getBrandById(id) {
        const brand = await BrandProfile.findById(id).populate('user', 'name email phone isVerified verificationBadge');
        if (!brand) throw new Error('Brand not found');

        // Every event this creator's account ever organised - cancelled, rejected
        // and removed ones included - so the admin sees the whole history. This
        // was capped at the latest 10, and the totals below were computed from
        // that slice, so an older creator's count and sales were understated.
        // Only the fields the page shows are read, to keep a long history light.
        const events = await Event.find({ organizer: brand.user._id })
            .select('name status startDateTime endDateTime venue customVenue.name customVenue.city isDeleted currentAttendees maxAttendees')
            .populate('venue', 'name')
            // startDateTime, not `date`: no such path on the schema, so this sort did
            // nothing and "latest events" was arbitrary.
            .sort({ startDateTime: -1 })
            .lean();

        // Revenue across all of them, computed the same way as before (sum of
        // ticket prices), now over the full history rather than ten events.
        const eventIds = events.map(e => e._id);
        const ticketRevenue = eventIds.length
            ? await Ticket.aggregate([
                { $match: { event: { $in: eventIds } } },
                { $group: { _id: null, total: { $sum: '$price' } } }
            ])
            : [];
        // Same rule as the Creators list count (getBrands), so both pages agree.
        const HOSTED = ['approved', 'upcoming', 'ongoing', 'completed'];
        const eventsHosted = events.filter(e => !e.isDeleted && HOSTED.includes(e.status)).length;

        return {
            ...brand.toObject(),
            events,
            stats: {
                // Spread the document stats first so followers/views (maintained
                // by the follow flow) survive; this used to overwrite the whole
                // object, dropping them to undefined → the UI showed 0 for every
                // creator.
                ...(brand.stats || {}),
                eventsHosted,
                totalEvents: events.length,
                totalRevenue: ticketRevenue[0]?.total || 0
            }
        };
    },

    /**
     * Approve, reject or block a creator profile - and move the account's badge with it.
     *
     * This only wrote BrandProfile.status before, while brandService granted
     * `verificationBadge` at profile-creation time. So the badge every creator feature
     * reads was handed out on application and this decision changed nothing about it:
     * approving was a no-op and rejecting left the applicant still badged as verified.
     *
     * Granting on approval and clearing on anything else makes this the single place
     * creator verification is decided.
     */
    async updateBrandStatus(brandId, status, adminUserId) {
        const before = await BrandProfile.findById(brandId).select('status name').lean();
        if (!before) throw new Error('Brand not found');

        const brand = await BrandProfile.findByIdAndUpdate(
            brandId,
            { $set: { status } },
            { new: true }
        );
        if (!brand) throw new Error('Brand not found');

        // Mirrors brandService's mapping: a profile has ten types, the badge
        // distinguishes three, and anything not a band or organiser is a 'brand'.
        const badgeForBrandType = (type) =>
            ({ band: 'band', organizer: 'organizer' })[String(type || '').toLowerCase()] || 'brand';

        if (brand.user) {
            await User.findByIdAndUpdate(brand.user, {
                $set:
                    status === 'approved'
                        ? { verificationBadge: badgeForBrandType(brand.type), isVerified: true }
                        // Rejected, blocked or back to pending: the account is not a
                        // verified creator, so the badge must go with it.
                        : { verificationBadge: 'none', isVerified: false },
            });
        }

        await adminService.recordAdminAction({
            adminUser: adminUserId,
            action: adminService.actionForStatus(status),
            entityType: 'creator',
            entityId: brandId,
            // badgeChanged records the side effect, which is the part an account holder
            // will ask about: this decision also grants or removes their verified tick.
            metadata: {
                name: before.name,
                field: 'status',
                from: before.status,
                to: status,
                badgeChanged: (before.status === 'approved') !== (status === 'approved'),
            },
        });

        // Tell the creator, including what happened to their verified badge.
        if (before.status !== status && brand.user) {
            const text = {
                approved: before.status === 'blocked'
                    ? { type: 'verification_approved', title: 'Your creator profile is visible again', message: `"${before.name}" has been unblocked and your verified badge is back.` }
                    : { type: 'verification_approved', title: 'Your creator profile is approved', message: `"${before.name}" is approved - you now have a verified badge on FIRA.` },
                rejected: { type: 'verification_rejected', title: 'Your creator profile was not approved', message: `"${before.name}" was not approved. Contact FIRA support to find out what to change.` },
                blocked: { type: 'system', title: 'Your creator profile was blocked', message: `"${before.name}" was blocked by FIRA and hidden from the site, and the verified badge was removed. Please contact FIRA support.` },
                pending: { type: 'system', title: 'Your creator profile is back in review', message: `"${before.name}" is being reviewed again by FIRA.` },
            }[status];
            if (text) {
                await adminService.notifyUser(brand.user, {
                    ...text,
                    data: { referenceId: brandId, referenceModel: 'BrandProfile', actionUrl: '/dashboard/brand' },
                });
            }
        }

        return brand;
    },

    /**
     * Hard-delete a creator profile so its owner can apply fresh.
     *
     * This is the escape hatch for "reset this account's creator identity", so it
     * has to undo everything applying created, or the user lands back in the dead
     * end the /create/creator guard describes: a profile they can no longer see but
     * that still blocks a new application.
     *
     *   - The BrandProfile document itself.
     *   - The owner's badge and verified flag. updateBrandStatus grants these on
     *     approval; nothing else clears them, so a delete that skipped this would
     *     leave a verified account with no profile behind the tick.
     *   - The brand's posts. Post.brand is a hard ref; orphaned posts would 500 any
     *     feed that populates it.
     *   - The brand from every follower's followingBrands array, so no user carries
     *     a dangling follow to a profile that no longer exists.
     *
     * Events the owner organised are deliberately left alone: they belong to the
     * user account, not the brand profile, and deleting a brand should not cancel
     * live events and refund ticket holders as a side effect.
     */
    async deleteBrand(brandId, adminUserId) {
        // Read before deleting: after the cascade there is no document left to name
        // in the audit entry, and the owner id is needed to reset the account.
        const brand = await BrandProfile.findById(brandId).select('name type user').lean();
        if (!brand) throw new Error('Brand not found');

        const Post = require('../models/Post');

        await Promise.all([
            BrandProfile.findByIdAndDelete(brandId),
            Post.deleteMany({ brand: brandId }),
            User.updateMany(
                { followingBrands: brandId },
                { $pull: { followingBrands: brandId } }
            ),
            brand.user
                ? User.findByIdAndUpdate(brand.user, {
                    $set: { verificationBadge: 'none', isVerified: false },
                })
                : Promise.resolve(),
        ]);

        await adminService.recordAdminAction({
            adminUser: adminUserId,
            action: 'delete',
            entityType: 'creator',
            entityId: brandId,
            metadata: { name: brand.name, type: brand.type },
        });
        await adminService.notifyUser(brand.user, {
            title: 'Your creator profile was removed',
            message: `"${brand.name}" was removed from FIRA and its verified badge was reset. You can create a new creator profile from your dashboard.`,
            data: { actionUrl: '/dashboard/brand' },
        });

        return { success: true };
    },

    // ================== AUDIT TRAIL ==================

    /** Largest page the audit endpoint will serve, whatever the caller asks for. */
    AUDIT_MAX_LIMIT: 100,

    /**
     * Clamp paging input. Pure, so it is checkable without a database.
     *
     * `limit` was passed straight to .limit() from the query string, so
     * `?limit=1000000` returned the entire audit table in one populated query - a table
     * that only ever grows, and now grows on every admin action rather than only on
     * deletes. `page` was equally unguarded: `?page=0` produced skip -20 and
     * `?page=abc` produced NaN, either of which Mongo rejects or silently mishandles.
     */
    auditPaging({ page = 1, limit = 20 } = {}) {
        const safePage = Math.max(1, Math.floor(Number(page)) || 1);
        const requested = Math.floor(Number(limit)) || 20;
        const safeLimit = Math.min(Math.max(1, requested), adminService.AUDIT_MAX_LIMIT);
        return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit };
    },

    async getAuditTrail({ page = 1, limit = 20, entityType, action } = {}) {
        const filter = {};
        if (entityType) filter.entityType = entityType;
        if (action) filter.action = action;

        const paging = adminService.auditPaging({ page, limit });
        const skip = paging.skip;
        const parsedLimit = paging.limit;

        const [entries, total] = await Promise.all([
            AuditLog.find(filter)
                .populate('adminUser', 'name email')
                .sort({ timestamp: -1 })
                .skip(skip)
                .limit(parsedLimit),
            AuditLog.countDocuments(filter)
        ]);

        return {
            entries,
            total,
            page: paging.page,
            // At least 1. An empty result used to report `pages: 0`, which the admin page
            // only survived because it reads `data.pages || data.totalPages || 1` and 0
            // is falsy - a coincidence, not a contract.
            pages: Math.max(1, Math.ceil(total / parsedLimit)),
        };
    }
};

module.exports = adminService;
