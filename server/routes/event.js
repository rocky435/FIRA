// @ts-check
const express = require('express');
const router = express.Router();
const eventService = require('../services/eventService');
const notificationService = require('../services/notificationService');
const earningsService = require('../services/earningsService');
const settlementService = require('../services/settlementService');

const auth = require('../middleware/auth');
const { requireAuth } = auth;
const { publicCache, noStoreCache, invalidateCache } = require('../middleware/httpCache');
const { optionalAuth } = auth;
const { loginLimiter } = require('../middleware/rateLimiters');
const { hasRole } = require('../utils/roleUtils');
const Event = require('../models/Event');

/**
 * Load the event and confirm the caller is its organizer (or an admin).
 * Edit, delete and cancel only required *a* signed-in user, so anyone could
 * change, delete or cancel (and mass-refund) any event.
 * Sends the 404/403 itself and returns null when the caller may not proceed.
 */
async function requireEventOrganizer(req, res) {
    const event = require('mongoose').isValidObjectId(req.params.id)
        ? await Event.findById(req.params.id).select('organizer')
        : null;
    if (!event) {
        res.status(404).json({ error: 'Event not found' });
        return null;
    }
    if (String(event.organizer) !== String(req.user._id) && !hasRole(req.user, 'admin')) {
        res.status(403).json({ error: 'Only the event organizer can do this' });
        return null;
    }
    return event;
}

/**
 * Once tickets are sold, the organizer cannot delete or cancel the event
 * themselves: the request is recorded for an admin, who removes it from the
 * admin panel (cancelling the tickets and raising the refunds). Responds 202 and
 * returns true when the request was sent; false when the caller may go ahead.
 */
async function sentToAdminForRemoval(req, res) {
    if (hasRole(req.user, 'admin')) return false;
    const removal = require('../services/listingRemovalService');
    if (!(await removal.eventHasSales(req.params.id))) return false;
    await removal.requestRemoval(Event, req.params.id, req.user._id, req.body && req.body.reason);
    res.status(202).json({
        deletionRequested: true,
        message: 'Tickets have been sold for this event, so it cannot be removed directly. Your request has been sent to the FIRA team for approval.',
    });
    return true;
}

/**
 * Validate ticketTiers array for event create/edit.
 * Returns an error string if invalid, null if valid.
 */
function validateTicketTiers(ticketTiers) {
    if (!ticketTiers || !Array.isArray(ticketTiers)) return null; // optional field, skip if absent
    if (ticketTiers.length < 1 || ticketTiers.length > 10) {
        return 'ticketTiers must contain between 1 and 10 tiers';
    }
    const names = new Set();
    for (const tier of ticketTiers) {
        if (!tier.name || typeof tier.name !== 'string' || tier.name.trim().length === 0 || tier.name.trim().length > 50) {
            return 'Each tier must have a name between 1 and 50 characters';
        }
        const normalizedName = tier.name.trim().toLowerCase();
        if (names.has(normalizedName)) {
            return 'Duplicate tier names are not allowed';
        }
        names.add(normalizedName);
        if (typeof tier.price !== 'number' || tier.price < 0) {
            return 'Each tier must have a price >= 0';
        }
        if (!Number.isInteger(tier.maxQuantity) || tier.maxQuantity < 1) {
            return 'Each tier must have a maxQuantity >= 1';
        }
    }
    return null;
}

/**
 * @typedef {import('../middleware/types').AuthenticatedRequest} AuthenticatedRequest
 * @typedef {import('express').Response} Response
 */

// GET /api/events - Get all events
// An organizer's own listing (?organizer=<self>) includes their private events,
// so it depends on who is asking and must never be stored by a shared cache.
const listingCache = (req, res, next) => (req.query.organizer ? noStoreCache : publicCache)(req, res, next);

router.get('/', optionalAuth, listingCache, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { includeCompleted, ...restQuery } = req.query;
        const events = await eventService.getAllEvents(restQuery, { viewerId: req.user?._id || null });

        // When includeCompleted=true, fetch completed events separately
        if (includeCompleted === 'true') {
            const Event = require('../models/Event');
            const completedEvents = await Event.find({
                status: 'completed',
                eventType: 'public',
                isDeleted: { $ne: true }
            })
                .select('-privateCode')
                .populate('organizer', 'name email verificationBadge')
                .populate('venue', 'name address images')
                .sort({ endDateTime: -1 })
                .limit(20)
                .lean();
            return res.json({ ...events, completedEvents });
        }

        res.json(events);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/events/sections - Fetch all homepage sections in one call
router.get('/sections', /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const [upcoming, top, latest] = await Promise.all([
            eventService.getAllEvents({ status: 'upcoming', eventType: 'public', sort: 'upcoming' }),
            eventService.getAllEvents({ status: 'upcoming', eventType: 'public', sort: 'top' }),
            eventService.getAllEvents({ eventType: 'public', sort: 'latest' }),
        ]);
        res.json({
            upcoming: upcoming.events || [],
            top: top.events || [],
            latest: latest.events || [],
        });
    } catch (error) {
        console.error('Error fetching event sections:', error);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/events/upcoming - Get upcoming events
router.get('/upcoming', /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const events = await eventService.getUpcomingEvents(req.query);
        res.json(events);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/events/venue-requests - Get events pending venue approval (for venue owners)
// Always the caller's own venues. The ?userId= the client still sends is ignored;
// it used to be trusted, so anyone could read any owner's request queue.
router.get('/venue-requests', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const result = await eventService.getVenueEventRequests(req.user._id, req.query);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/events/admin-pending - Get events pending admin approval
router.get('/admin-pending', requireAuth('admin'), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const result = await eventService.getPendingAdminApproval(req.query);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/events/:id - Get event by ID
router.get('/:id', optionalAuth, noStoreCache, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const event = await eventService.getEventById(req.params.id, req.user?._id || null, {
            viewerIsAdmin: hasRole(req.user, 'admin'),
        });
        res.json(event);
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

// POST /api/events/:id/verify-code - Check a private event's access code
// The code is checked here, never in the browser (the page no longer receives
// it). Rate-limited so codes cannot be guessed by brute force.
router.post('/:id/verify-code', loginLimiter, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const valid = await eventService.checkPrivateCode(req.params.id, req.body && req.body.code);
        if (!valid) return res.status(400).json({ error: 'Invalid access code' });
        res.json({ valid: true });
    } catch (error) {
        res.status(404).json({ error: 'Event not found' });
    }
});

// GET /api/events/:id/earnings - Per-event earnings breakdown (organizer only)
// Behind requireAuth(); earningsService enforces organizer ownership server-side
// and throws an error with status 403 for non-owners, returning no data.
router.get('/:id/earnings', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const earnings = await earningsService.getEventEarnings(req.params.id, req.user._id);
        res.json(earnings);
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

// GET /api/events/:id/settlement - Owner_Settlement_View data for one event
// (Requirements 9.1, 9.2, 11.5). Same shape as /earnings above: behind auth,
// with ownership enforced server-side inside getOwnerSettlement, which throws an
// error carrying status 403 for a non-organizer, an absent event, or a malformed
// id — all the same rejection, so no figures leak and a prober learns nothing.
// The owner surface is read-only: GET only, no write route (Requirement 9.6).
router.get('/:id/settlement', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const settlement = await settlementService.getOwnerSettlement({
            kind: 'event',
            listingId: req.params.id,
            requesterId: req.user._id,
        });
        res.json(settlement);
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

// POST /api/events - Create new event
router.post('/', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        // Validate ticketTiers if provided
        const tierError = validateTicketTiers(req.body.ticketTiers);
        if (tierError) {
            return res.status(400).json({ error: tierError });
        }

        const eventData = { ...req.body, organizer: req.user._id };
        const event = await eventService.createEvent(eventData);
        await invalidateCache('events');
        res.status(201).json(event);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// PUT /api/events/:id - Update event
router.put('/:id', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        // Validate ticketTiers if provided
        const tierError = validateTicketTiers(req.body.ticketTiers);
        if (tierError) {
            return res.status(400).json({ error: tierError });
        }

        if (!(await requireEventOrganizer(req, res))) return;

        // Fetch current event state to detect field changes for notifications
        const currentEvent = await eventService.getEventById(req.params.id);

        const event = await eventService.updateEvent(req.params.id, req.body);
        await invalidateCache('events');

        // Detect changes to notifiable fields and fire notifications asynchronously
        const trackedFields = ['name', 'startDateTime', 'endDateTime', 'venue', 'description'];
        const changedFields = [];
        for (const field of trackedFields) {
            const oldVal = currentEvent[field];
            const newVal = req.body[field];
            if (newVal !== undefined) {
                // Compare as strings to handle ObjectIds and Date objects
                const oldStr = oldVal != null ? String(oldVal._id || oldVal) : '';
                const newStr = newVal != null ? String(newVal) : '';
                if (oldStr !== newStr) {
                    changedFields.push(field);
                }
            }
        }

        if (changedFields.length > 0) {
            // Fire-and-forget with error swallowing — don't block the response
            notificationService.sendEventUpdateNotifications(event, changedFields, req.user).catch(err => {
                console.error('Failed to send event update notifications:', err.message);
            });
        }

        res.json(event);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// DELETE /api/events/:id - Delete event
router.delete('/:id', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        if (!(await requireEventOrganizer(req, res))) return;
        if (await sentToAdminForRemoval(req, res)) return;
        await eventService.deleteEvent(req.params.id);
        await invalidateCache('events');
        res.json({ message: 'Event deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/events/:id/cancel - Cancel event
router.post('/:id/cancel', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        if (!(await requireEventOrganizer(req, res))) return;
        if (await sentToAdminForRemoval(req, res)) return;
        const { reason } = req.body;
        const result = await eventService.cancelEvent(req.params.id, reason);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/events/:id/access - Request access to private event
router.post('/:id/access', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const result = await eventService.requestPrivateAccess(req.params.id, { ...req.body, userId: req.user._id });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// PUT /api/events/:id/access/:requestId - Approve/reject access request
// Organizer (or admin) only - see eventService.handleAccessRequest.
router.put('/:id/access/:requestId', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const result = await eventService.handleAccessRequest(req.params.requestId, req.body.status, {
            eventId: req.params.id,
            actorId: req.user._id,
            isAdmin: hasRole(req.user, 'admin'),
        });
        res.json(result);
    } catch (error) {
        res.status(/** @type {any} */ (error).status || 400).json({ error: error.message });
    }
});

// POST /api/events/:id/venue-approve - Venue owner approves/rejects event
// The owner is the signed-in caller. venueOwnerId used to be read from the body,
// and owner ids are public, so anyone could approve on an owner's behalf.
router.post('/:id/venue-approve', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { status, rejectionReason } = req.body;
        if (!status) {
            return res.status(400).json({ error: 'status is required' });
        }
        const event = await eventService.venueApproveEvent(req.params.id, req.user._id.toString(), { status, rejectionReason });
        await invalidateCache('events');
        res.json(event);
    } catch (error) {
        res.status(/** @type {any} */ (error).status || 400).json({ error: error.message });
    }
});

// POST /api/events/:id/admin-approve - Admin approves/rejects event
// Admin only; the acting admin is the caller (adminId in the body is ignored).
router.post('/:id/admin-approve', requireAuth('admin'), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { status, rejectionReason } = req.body;
        if (!status) {
            return res.status(400).json({ error: 'status is required' });
        }
        const event = await eventService.adminApproveEvent(req.params.id, req.user._id.toString(), { status, rejectionReason });
        await invalidateCache('events');
        res.json(event);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// =================== SCANNING CODE ROUTES ===================

/**
 * GET /api/events/:id/scanning-codes - the event's scanner links (organizer only).
 *
 * Provisions a link for any tier missing one before returning, so there is nothing to
 * generate: the organiser opens the event and copies the link for the tier they need.
 */
router.get('/:id/scanning-codes', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const codes = await eventService.listScanningCodes(req.params.id, req.user._id);
        res.json(codes);
    } catch (error) {
        const status = error.message.includes('not found') ? 404
            : error.message.includes('Only the event organizer') ? 403
            : 400;
        res.status(status).json({ error: error.message });
    }
});

// PATCH /api/events/:id/scanning-codes/:codeId/deactivate - Deactivate a scanning code
router.patch('/:id/scanning-codes/:codeId/deactivate', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const code = await eventService.deactivateScanningCode(req.params.codeId, req.user._id);
        res.json(code);
    } catch (error) {
        const status = error.message.includes('not found') ? 404
            : error.message.includes('Only the code creator') ? 403
            : 400;
        res.status(status).json({ error: error.message });
    }
});

// =================== EVENT POST ROUTES ===================
const postService = require('../services/postService');

// GET /api/events/:id/posts - Get all posts for an event
router.get('/:id/posts', /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const result = await postService.getEventPosts(req.params.id, /** @type {any} */ (req.query.page), /** @type {any} */ (req.query.limit));
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/events/:id/posts - Create a post for an event
router.post('/:id/posts', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    const { content, images } = req.body;

    try {
        const post = await postService.createEventPost(req.params.id, req.user._id, { content, images });
        res.status(201).json(post);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// PUT /api/events/:id/posts/:postId - Update an event post
router.put('/:id/posts/:postId', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    const { content, images } = req.body;

    try {
        const post = await postService.updateEventPost(req.params.postId, req.params.id, req.user._id, { content, images });
        res.json(post);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// DELETE /api/events/:id/posts/:postId - Delete an event post
router.delete('/:id/posts/:postId', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const result = await postService.deleteEventPost(req.params.postId, req.params.id, req.user._id);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/events/:id/posts/:postId/like - Toggle like on a post
router.post('/:id/posts/:postId/like', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const result = await postService.toggleLike(req.params.postId, req.user._id);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/events/:id/posts/:postId/comments - Add comment to a post
router.post('/:id/posts/:postId/comments', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Content required' });

    try {
        const comments = await postService.addComment(req.params.postId, req.user._id, content);
        res.json({ comments });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// DELETE /api/events/:id/posts/:postId/comments/:commentId - Delete a comment
router.delete('/:id/posts/:postId/comments/:commentId', auth, /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const result = await postService.deleteComment(req.params.postId, req.params.commentId, req.user._id);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

module.exports = router;

