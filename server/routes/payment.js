// @ts-check
const express = require('express');
const router = express.Router();
const paymentService = require('../services/paymentService');
const discountService = require('../services/discountService');

const { requireAuth } = require('../middleware/auth');
const roleGuard = require('../middleware/roleGuard');
const { hasRole } = require('../utils/roleUtils');
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Refund = require('../models/Refund');

/**
 * @typedef {import('../middleware/types').AuthenticatedRequest} AuthenticatedRequest
 * @typedef {import('express').Response} Response
 */

// GET /api/payments - Get all payments (admin only)
router.get('/', requireAuth('admin'), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const payments = await paymentService.getAllPayments(req.query);
        res.json(payments);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/payments/user/:userId - Get user's payments
router.get('/user/:userId', requireAuth('user', 'admin'), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        if (!hasRole(req.user, 'admin') && req.params.userId !== req.user._id.toString()) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        const payments = await paymentService.getUserPayments(req.params.userId);
        res.json(payments);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/payments/:id - Get payment by ID (its payer or an admin)
// Any signed-in user could read any payment. A non-id segment (e.g. "refunds")
// falls through to the routes below - this one used to swallow GET /refunds.
router.get('/:id', (req, res, next) => (mongoose.isValidObjectId(req.params.id) ? next() : next('route')),
    requireAuth('user', 'admin'), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const owned = await Payment.exists({ _id: req.params.id, user: req.user._id });
        if (!owned && !hasRole(req.user, 'admin')) {
            return res.status(404).json({ error: 'Payment not found' });
        }
        const payment = await paymentService.getPaymentById(req.params.id);
        res.json(payment);
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

// POST /api/payments/calculate-billing - Calculate billing breakdown (user)
router.post('/calculate-billing', requireAuth('user'), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { ticketPrice, quantity, platformFeePercentage, discountAmount } = req.body;
        if (ticketPrice == null || quantity == null || platformFeePercentage == null) {
            return res.status(400).json({ error: 'ticketPrice, quantity, and platformFeePercentage are required' });
        }
        const billing = paymentService.calculateBilling(ticketPrice, quantity, platformFeePercentage, discountAmount || 0);
        res.json(billing);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/payments/apply-discount - Preview a discount code (user)
//
// Validates the code and prices it against the order's total payable. It does
// NOT redeem the code - that happens once, at purchase, where the server
// re-validates and re-prices it from the event's own prices.
router.post('/apply-discount', requireAuth('user'), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        // Discounts apply to the ticket subtotal (price x quantity), not the fee
        // or GST. Older clients sent the total payable as `amount`.
        const { code, eventId } = req.body;
        const amount = req.body.subtotal ?? req.body.amount;
        if (!code || !eventId || amount == null) {
            return res.status(400).json({ error: 'code, eventId, and amount are required' });
        }
        const { discountBearer, ...result } = await discountService.validateAndApplyDiscount(
            code, eventId, Number(amount), { consume: false }
        );
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/payments/initiate - Initiate payment (admin only)
// Every amount here comes from the request body, so a buyer could open a ₹1
// order for a ₹999 ticket. Checkout creates its orders server-side (ticket
// purchase and the booking initiate-payment routes); nothing in the apps calls this.
router.post('/initiate', requireAuth('admin'), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const paymentData = { ...req.body, userId: req.user._id };
        const result = await paymentService.initiatePayment(paymentData);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/payments/verify - Verify payment (requirement 3.4: auth required)
router.post('/verify', requireAuth('user', 'admin'), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { paymentId, gatewayOrderId, gatewayPaymentId, gatewaySignature } = req.body;
        // A non-admin can only verify their own payment.
        const result = await paymentService.verifyPayment(
            { paymentId, gatewayOrderId, gatewayPaymentId, gatewaySignature },
            { actorId: hasRole(req.user, 'admin') ? null : req.user._id }
        );
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/payments/webhook - Razorpay server-to-server payment events
// No session: Razorpay authenticates with the X-Razorpay-Signature header, an
// HMAC of the raw body under RAZORPAY_WEBHOOK_SECRET. See paymentService.handleWebhook.
router.post('/webhook', /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { status, body } = await paymentService.handleWebhook(
            /** @type {any} */ (req).rawBody,
            req.header('x-razorpay-signature')
        );
        res.status(status).json(body);
    } catch (error) {
        // Unexpected (e.g. database down): 500 so Razorpay retries later.
        console.error('Razorpay webhook failed:', error.message);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// POST /api/payments/:id/refund - Raise a refund request for a payment (admin only)
// This used to refund straight through Razorpay, skipping "Refunds to be done".
// Every refund now goes through that queue: this only records a pending
// request, which an admin then pays by hand and marks refunded.
router.post('/:id/refund', requireAuth('admin'), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const refundService = require('../services/refundService');
        const { amount, reasonDetails } = req.body || {};
        const refund = await refundService.processRefund(req.params.id, {
            amount: amount == null ? undefined : amount,
            reason: 'admin_initiated',
            reasonDetails: typeof reasonDetails === 'string' ? reasonDetails : `Raised by admin ${req.user._id}`,
        });
        res.status(201).json(refund);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// GET /api/payments/payouts/all - Get all payouts (admin)
router.get('/payouts/all', requireAuth('admin'), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const payouts = await paymentService.getAllPayouts(req.query);
        res.json(payouts);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/payments/payouts - Raise a payout (admin)
//
// The payout is exactly the typed amount; no commission is taken from it.
router.post('/payouts', requireAuth('admin'), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { recipientId, type, referenceId, referenceModel, amount, grossAmount, notes } = req.body;
        const result = await paymentService.processPayout({
            recipientId, type, referenceId, referenceModel, amount, grossAmount, notes,
            initiatedBy: req.user._id,
        });
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ============= REFUND ROUTES =============

const refundService = require('../services/refundService');

// GET /api/payments/refunds - Get all refunds (admin)
router.get('/refunds', requireAuth('admin'), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const refunds = await refundService.getAllRefunds(req.query);
        res.json(refunds);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/payments/refunds/user/:userId - Get user's refunds
router.get('/refunds/user/:userId', requireAuth('user', 'admin'), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        if (!hasRole(req.user, 'admin') && req.params.userId !== req.user._id.toString()) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        const refunds = await refundService.getRefundsByUser(req.params.userId);
        res.json(refunds);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/payments/refunds/:id - Get refund details (its owner or an admin)
router.get('/refunds/:id', requireAuth('user', 'admin'), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const owned = mongoose.isValidObjectId(req.params.id) &&
            await Refund.exists({ _id: req.params.id, user: req.user._id });
        if (!owned && !hasRole(req.user, 'admin')) {
            return res.status(404).json({ error: 'Refund not found' });
        }
        const refund = await refundService.getRefundById(req.params.id);
        res.json(refund);
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

// POST /api/payments/refunds/:id/process - Approve or reject a refund request
// Every customer refund is raised as a pending request ("Refunds to be done").
// Refunds are paid manually; approving records it as paid, with the reference.
// Admin or super-admin only - not moderators.
router.post('/refunds/:id/process', requireAuth('admin'), roleGuard(['super_admin', 'admin']), /** @param {AuthenticatedRequest} req @param {Response} res */ async (req, res) => {
    try {
        const { action, notes, reference } = req.body;
        const refund = await refundService.processRefundRequest(req.params.id, req.user._id, action, notes, reference);
        res.json(refund);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

module.exports = router;
