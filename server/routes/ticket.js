const express = require('express');
const router = express.Router();
const ticketService = require('../services/ticketService');

const auth = require('../middleware/auth');
const { requireAuth } = auth;
const { noStoreCache } = require('../middleware/httpCache');
const { hasRole } = require('../utils/roleUtils');
const mongoose = require('mongoose');
const Event = require('../models/Event');
const Ticket = require('../models/Ticket');

/*
 * Every read and check-in route here used to be public: anyone could list every
 * buyer's name, email and QR code (and walk in on a copied QR), or mark any
 * ticket used to block its holder at the door. Now:
 *   - a ticket is visible to its holder, its event's organizer, and admins
 *   - an event's ticket list, stats and scanning belong to its organizer and admins
 */

/** Organizer of `eventId`, or an admin. */
async function canManageEvent(user, eventId) {
    if (hasRole(user, 'admin')) return true;
    if (!mongoose.isValidObjectId(eventId)) return false;
    const event = await Event.findById(eventId).select('organizer').lean();
    return !!event && String(event.organizer) === String(user._id);
}

/**
 * Express guard: the caller manages the event named by `req.params.eventId`
 * (or req.body.eventId). Sends 403 itself.
 */
async function requireEventManager(req, res, next) {
    const eventId = req.params.eventId || (req.body && req.body.eventId);
    try {
        if (await canManageEvent(req.user, eventId)) return next();
    } catch (_) { /* fall through to 403 */ }
    return res.status(403).json({ error: 'Only the event organizer can do this' });
}

/**
 * Load a ticket the caller may see: its holder, the event organizer, or an admin.
 * Sends 404/403 itself and returns null otherwise.
 */
async function loadVisibleTicket(req, res) {
    const ticket = mongoose.isValidObjectId(req.params.id)
        ? await Ticket.findById(req.params.id).select('user event').lean()
        : null;
    if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' });
        return null;
    }
    const isHolder = String(ticket.user) === String(req.user._id);
    if (!isHolder && !(await canManageEvent(req.user, ticket.event))) {
        res.status(403).json({ error: 'Unauthorized' });
        return null;
    }
    return ticket;
}

// GET /api/tickets - Get all tickets (admin only)
router.get('/', requireAuth('admin'), noStoreCache, async (req, res) => {
    try {
        const tickets = await ticketService.getAllTickets(req.query);
        res.json(tickets);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/tickets/user/:userId - Get user's tickets
router.get('/user/:userId', auth, noStoreCache, async (req, res) => {
    try {
        if (req.params.userId !== req.user._id.toString()) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        const tickets = await ticketService.getUserTickets(req.params.userId);
        res.json(tickets);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/tickets/event/:eventId - Get event's tickets (organizer or admin)
router.get('/event/:eventId', auth, requireEventManager, noStoreCache, async (req, res) => {
    try {
        const tickets = await ticketService.getEventTickets(req.params.eventId);
        res.json(tickets);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/tickets/:id - Get ticket by ID (holder, event organizer or admin)
router.get('/:id', auth, noStoreCache, async (req, res) => {
    try {
        if (!(await loadVisibleTicket(req, res))) return;
        const ticket = await ticketService.getTicketById(req.params.id);
        res.json(ticket);
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

// POST /api/tickets - Purchase ticket
router.post('/', auth, async (req, res) => {
    try {
        const ticketData = { ...req.body, userId: req.user._id };
        const ticket = await ticketService.purchaseTicket(ticketData);
        res.status(201).json(ticket);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/tickets/:id/validate - Validate ticket (check-in; organizer or admin)
router.post('/:id/validate', auth, async (req, res) => {
    try {
        const ticket = mongoose.isValidObjectId(req.params.id)
            ? await Ticket.findById(req.params.id).select('event').lean()
            : null;
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
        if (!(await canManageEvent(req.user, ticket.event))) {
            return res.status(403).json({ error: 'Only the event organizer can check tickets in' });
        }
        const result = await ticketService.validateTicket(req.params.id, req.body.qrCode);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/tickets/scan - Scan ticket via QR code (organizer scanner UI)
// Door staff without an account use the scanning-link flow (/api/scan/:code).
router.post('/scan', auth, async (req, res) => {
    try {
        const { qrData, eventId } = req.body;

        if (!qrData || !eventId) {
            return res.status(400).json({ error: 'Missing qrData or eventId' });
        }
        if (!(await canManageEvent(req.user, eventId))) {
            return res.status(403).json({ error: 'Only the event organizer can scan tickets for this event' });
        }

        const result = await ticketService.scanTicket({
            qrData,
            // Who checked the guest in is the signed-in scanner, not a body field.
            scannerId: req.user._id.toString(),
            eventId: String(eventId)
        });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// GET /api/tickets/event/:eventId/stats - Get scan stats for event (organizer or admin)
router.get('/event/:eventId/stats', auth, requireEventManager, noStoreCache, async (req, res) => {
    try {
        const tickets = await ticketService.getEventTickets(req.params.eventId);
        const total = tickets.length;
        const scanned = tickets.filter(t => t.isUsed || t.status === 'used').length;
        const totalAttendees = tickets.reduce((sum, t) => sum + (t.quantity || 1), 0);
        const scannedAttendees = tickets.filter(t => t.isUsed || t.status === 'used')
            .reduce((sum, t) => sum + (t.quantity || 1), 0);

        res.json({
            totalTickets: total,
            scannedTickets: scanned,
            totalAttendees,
            scannedAttendees,
            pending: total - scanned
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/tickets/:id/cancel - Cancel ticket (admin-only)
router.post('/:id/cancel', auth, async (req, res) => {
    try {
        // Only admins can cancel tickets
        if (req.user.role !== 'admin' && !req.user.adminRole) {
            return res.status(403).json({ error: "Ticket cancellation is not available for non-admin users" });
        }

        const ticket = await ticketService.cancelTicket(req.params.id, req.user._id.toString(), req.body.reason);
        res.json(ticket);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// GET /api/tickets/:id/refund-eligibility - what a cancellation would refund
//
// The cancellation modal calls this as soon as it opens. The route was never
// implemented, so Express fell through to its default HTML 404 and the client
// tried to JSON.parse "<!DOCTYPE html>..." - surfacing as
// "Unexpected token '<' ... is not valid JSON" inside the modal.
router.get('/:id/refund-eligibility', auth, async (req, res) => {
    try {
        if (!(await loadVisibleTicket(req, res))) return;
        const eligibility = await ticketService.checkRefundEligibility(req.params.id);
        res.json(eligibility);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

module.exports = router;
