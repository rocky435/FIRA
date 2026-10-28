const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const verificationService = require('../services/verificationService');
const VerificationRequest = require('../models/VerificationRequest');
const auth = require('../middleware/auth');
const { requireAuth } = auth;
const { hasRole } = require('../utils/roleUtils');

/*
 * Every route here used to be public: anyone could list every applicant's
 * submitted ID documents, or approve their own request and get a verified badge.
 * Applicants now see and edit only their own request; listing and review are
 * admin-only, and the reviewer is the signed-in admin.
 */

// What an applicant may set. Status, reviewer and review notes are the admin's.
const APPLICANT_FIELDS = ['type', 'name', 'description', 'documents', 'socialLinks', 'portfolio', 'followerCount'];

function pickApplicantFields(body) {
    const picked = {};
    for (const key of APPLICANT_FIELDS) {
        if (body && body[key] !== undefined) picked[key] = body[key];
    }
    return picked;
}

/** The request's applicant or an admin; sends 404/403 itself, returns null otherwise. */
async function loadOwnRequest(req, res) {
    const request = mongoose.isValidObjectId(req.params.id)
        ? await VerificationRequest.findById(req.params.id).select('user').lean()
        : null;
    if (!request) {
        res.status(404).json({ error: 'Verification request not found' });
        return null;
    }
    if (String(request.user) !== String(req.user._id) && !hasRole(req.user, 'admin')) {
        res.status(403).json({ error: 'Unauthorized' });
        return null;
    }
    return request;
}

// GET /api/verification - Get all verification requests (admin)
router.get('/', requireAuth('admin'), async (req, res) => {
    try {
        const requests = await verificationService.getAllRequests(req.query);
        res.json(requests);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/verification/user/:userId - Get user's verification request (self or admin)
router.get('/user/:userId', auth, async (req, res) => {
    try {
        if (req.params.userId !== req.user._id.toString() && !hasRole(req.user, 'admin')) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        const request = await verificationService.getUserRequest(req.params.userId);
        res.json(request);
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

// GET /api/verification/:id - Get request by ID (applicant or admin)
router.get('/:id', auth, async (req, res) => {
    try {
        if (!(await loadOwnRequest(req, res))) return;
        const request = await verificationService.getRequestById(req.params.id);
        res.json(request);
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

// POST /api/verification - Submit verification request (for the signed-in user)
router.post('/', auth, async (req, res) => {
    try {
        const request = await verificationService.submitRequest({
            ...pickApplicantFields(req.body),
            user: req.user._id,
        });
        res.status(201).json(request);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// PUT /api/verification/:id - Update verification request (applicant, while pending)
router.put('/:id', auth, async (req, res) => {
    try {
        if (!(await loadOwnRequest(req, res))) return;
        const request = await verificationService.updateRequest(req.params.id, pickApplicantFields(req.body));
        res.json(request);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// PUT /api/verification/:id/review - Review request (admin)
router.put('/:id/review', requireAuth('admin'), async (req, res) => {
    try {
        const { status, rejectionReason, adminNotes } = req.body;
        if (!['under_review', 'approved', 'rejected'].includes(status)) {
            return res.status(400).json({ error: 'Status must be under_review, approved or rejected' });
        }
        const result = await verificationService.reviewRequest(req.params.id, {
            status,
            rejectionReason,
            adminNotes,
            reviewedBy: req.user._id,
        });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

module.exports = router;
