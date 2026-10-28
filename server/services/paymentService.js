const Payment = require('../models/Payment');
const Payout = require('../models/Payout');
const User = require('../models/User');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { roundMoney, toPaise } = require('../utils/money');

// Owner bank details must be real before a payout is recorded (fail closed).
// ponytail: inline check here; the shared API-boundary validator is task 8.
/**
 * The payout account a listing named, if any.
 *
 * Events and venues store `payoutAccount` - an id into the owner's
 * `User.bankAccounts`. Returns null when the listing named nothing, or named an
 * account that has since been deleted; the caller then falls back to the owner's
 * default so a deleted account degrades to "pay the default" rather than failing.
 */
async function resolveListingPayoutAccount({ owner, referenceId, referenceModel }) {
    if (!owner || !Array.isArray(owner.bankAccounts) || owner.bankAccounts.length === 0) return null;
    if (!referenceId || !referenceModel) return null;

    const Model = referenceModel === 'Event'
        ? require('../models/Event')
        : referenceModel === 'Venue'
            ? require('../models/Venue')
            : null;
    if (!Model) return null;

    const listing = await Model.findById(referenceId).select('payoutAccount');
    if (!listing || !listing.payoutAccount) return null;

    return owner.bankAccounts.find(
        (a) => String(a._id) === String(listing.payoutAccount)
    ) || null;
}

/**
 * Count one use of the ticket discount code this payment was priced with. Called
 * once per payment, from the atomic pending→success flip, so a confirmed sale is
 * counted exactly once and an abandoned checkout never is. Not capped at maxUses:
 * the buyer has already paid the discounted price, so the sale is honoured even
 * if the last uses went to concurrent checkouts.
 */
async function countDiscountRedemption(payment) {
    if (payment.type !== 'ticket' || !payment.discountCode || !(Number(payment.discountAmount) > 0)) return;
    try {
        const DiscountCode = require('../models/DiscountCode');
        await DiscountCode.updateOne(
            { code: String(payment.discountCode).toUpperCase(), event: payment.referenceId },
            { $inc: { usedCount: 1 } }
        );
    } catch (err) {
        // Bookkeeping only - never fail a confirmed payment over it.
        console.error('Failed to count discount redemption:', err.message);
    }
}

/**
 * Mark a payment successful for gateway payment `gatewayPaymentId`. The flip is
 * atomic, so /verify and the webhook racing each other confirm it once (and
 * count its discount once). Returns the payment if it is now confirmed by that
 * gateway payment - including when it already was - or null if it can't be
 * (refunded, or confirmed by a different gateway payment).
 */
async function confirmPayment(paymentId, gatewayPaymentId) {
    // 'success' (not 'paid') matches the status the rest of the code reads.
    const updated = await Payment.findOneAndUpdate(
        { _id: paymentId, status: { $in: ['pending', 'failed'] } },
        { $set: { status: 'success', gatewayTransactionId: gatewayPaymentId, paidAt: new Date() } },
        { new: true }
    );
    if (updated) {
        await countDiscountRedemption(updated);
        return updated;
    }

    // Already confirmed: a repeat (double tap, retry after a dropped response,
    // webhook after verify) is fine; anything else is not.
    const latest = await Payment.findById(paymentId);
    if (latest && latest.status === 'success' && latest.gatewayTransactionId === gatewayPaymentId) {
        return latest;
    }
    return null;
}

/**
 * Deliver what a confirmed payment bought: issue the ticket order, or record the
 * advance/balance on the booking. Safe to call more than once for one payment.
 * A failure is logged, not thrown - the payment is real, so it needs a person
 * (refund or manual issue), and a gateway retry would fail the same way.
 */
async function fulfilConfirmedPayment(payment) {
    try {
        if (payment.type === 'ticket' && payment.referenceModel === 'Event') {
            const meta = payment.metadata || {};
            if (!meta.quantity) {
                console.error(`Confirmed ticket payment ${payment._id} has no order details; issue manually`);
                return;
            }
            const ticketService = require('./ticketService');
            await ticketService.purchaseTicket({
                userId: payment.user,
                eventId: payment.referenceId,
                quantity: meta.quantity,
                ...(meta.ticketType ? { ticketType: meta.ticketType } : {}),
                paymentId: payment._id,
            });
        } else if (payment.referenceModel === 'Booking') {
            const bookingService = require('./bookingService');
            await bookingService.fulfilConfirmedPayment(payment);
        }
    } catch (err) {
        console.error(`Could not fulfil confirmed payment ${payment._id}: ${err.message} - needs a refund or manual issue`);
    }
}

/** Constant-time comparison of the expected and supplied hex signatures. */
function signaturesMatch(expected, given) {
    if (typeof given !== 'string' || given.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

const isValidBankDetails = (b) =>
    !!b &&
    /^[0-9]{9,18}$/.test(b.accountNumber || '') &&
    /^[A-Z]{4}0[A-Z0-9]{6}$/.test(b.ifscCode || '');

const paymentService = {
    // Pure billing calculation with GST breakdown.
    //
    // A discount comes off the TOTAL PAYABLE (ticket + platform fee + GST), not
    // off the ticket price. Taking it off the ticket price first shrank the fee
    // and GST with it, so a ₹99 code on a ₹99 ticket zeroed the whole bill
    // instead of leaving the buyer to pay the ₹5.84 of fee + GST - and a
    // percentage code was worth less than its label on every order.
    // Fee and GST are always charged on the full ticket subtotal.
    calculateBilling(ticketPrice, quantity, platformFeePercentage, discountAmount = 0) {
        // Rounded to paise at each step, in this order. Rounding the sum instead
        // would let the displayed lines disagree with the total by a paise.
        const subtotal = roundMoney(ticketPrice * quantity);
        const platformFee = roundMoney(subtotal * platformFeePercentage / 100);
        const gstAmount = roundMoney(platformFee * 0.18);
        const grossTotal = roundMoney(subtotal + platformFee + gstAmount);
        // A discount comes off the ticket price only: never more than the
        // subtotal, never negative. The platform fee and GST are charged on the
        // listed price in full, so a deep discount code cannot shrink them (a
        // 99% code used to take 99% of the fee and GST too).
        const appliedDiscount = roundMoney(Math.min(Math.max(0, Number(discountAmount) || 0), subtotal));
        const totalAmount = roundMoney(grossTotal - appliedDiscount);

        return {
            subtotal,
            discountAmount: appliedDiscount,
            platformFee,
            platformFeePercentage,
            gstAmount,
            grossTotal,
            totalAmount
        };
    },

    // Get all payments
    async getAllPayments(query = {}) {
        const { page = 1, limit = 10, status, type } = query;
        const filter = {};
        if (status) filter.status = status;
        if (type) filter.type = type;

        const payments = await Payment.find(filter)
            .populate('user', 'name email')
            .limit(limit * 1)
            .skip((page - 1) * limit)
            .sort({ createdAt: -1 });

        const total = await Payment.countDocuments(filter);

        return {
            payments,
            totalPages: Math.ceil(total / limit),
            currentPage: page,
            total
        };
    },

    // Get user's payments
    async getUserPayments(userId) {
        const payments = await Payment.find({ user: userId })
            .sort({ createdAt: -1 });
        return payments;
    },

    // Get payment by ID
    async getPaymentById(id) {
        const payment = await Payment.findById(id).populate('user', 'name email');
        if (!payment) {
            throw new Error('Payment not found');
        }
        return payment;
    },

    // Initiate payment
    async initiatePayment({ userId, type, referenceId, referenceModel, amount, subtotal, platformFee, platformFeePercentage, gstAmount, totalAmount, discountCode, discountAmount, discountBearer, listedPrice, metadata = {} }) {
        if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
            throw new Error('Razorpay credentials not configured');
        }

        const razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });

        // Use totalAmount if provided (from billing calculation), otherwise fall back to amount
        const chargeAmount = totalAmount || amount;

        const options = {
            amount: toPaise(chargeAmount), // smallest currency unit (paise)
            currency: "INR",
            receipt: `rcpt_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            notes: {
                userId: userId.toString(),
                type,
                referenceId: referenceId.toString()
            }
        };

        const order = await razorpay.orders.create(options);

        const payment = await Payment.create({
            user: userId,
            type,
            referenceId,
            referenceModel,
            amount: chargeAmount,
            subtotal: subtotal || 0,
            platformFee: platformFee || 0,
            platformFeePercentage: platformFeePercentage || 5,
            gstAmount: gstAmount || 0,
            totalAmount: totalAmount || chargeAmount,
            discountCode: discountCode || null,
            discountAmount: discountAmount || 0,
            // Flow 4: who absorbs the discount ('platform'|'owner'|null) and the
            // full listed price the owner set. listedPrice defaults to subtotal
            // so platform-side records preserve intent even when no discount.
            discountBearer: discountBearer || null,
            listedPrice: listedPrice != null ? listedPrice : (subtotal || 0),
            metadata,
            status: 'pending',
            gatewayOrderId: order.id,
            gatewayResponse: order
        });

        return {
            payment,
            gatewayOrderId: order.id,
            keyId: process.env.RAZORPAY_KEY_ID,
            amount: options.amount,
            currency: options.currency
        };
    },

    // Verify payment (callback from gateway)
    //
    // The Razorpay signature proves that payment `gatewayPaymentId` was made
    // against order `gatewayOrderId` - nothing more. It used to be checked without
    // tying that order to *this* payment record, so a signature from a ₹1 order
    // could mark any other payment (a ₹50,000 booking) as paid. The order must now
    // be the one this payment created. `actorId`, when given, must own the payment;
    // otherwise anyone could also mark a stranger's pending payment as failed.
    async verifyPayment({ paymentId, gatewayOrderId, gatewayPaymentId, gatewaySignature }, { actorId = null } = {}) {
        const payment = require('mongoose').isValidObjectId(paymentId)
            ? await Payment.findById(paymentId)
            : null;
        if (!payment || (actorId && String(payment.user) !== String(actorId))) {
            throw new Error('Payment not found');
        }

        if (!payment.gatewayOrderId || typeof gatewayOrderId !== 'string' || gatewayOrderId !== payment.gatewayOrderId) {
            throw new Error('Payment verification failed: order does not match this payment');
        }

        const generated_signature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(gatewayOrderId + "|" + gatewayPaymentId)
            .digest('hex');

        if (!signaturesMatch(generated_signature, gatewaySignature)) {
            // Only a payment still awaiting confirmation is marked failed; a bad
            // signature must never undo one that already succeeded.
            await Payment.updateOne({ _id: payment._id, status: 'pending' }, { $set: { status: 'failed' } });
            throw new Error('Payment verification failed: Invalid signature');
        }

        const confirmed = await confirmPayment(payment._id, gatewayPaymentId);
        if (confirmed) {
            return { success: true, payment: confirmed };
        }
        throw new Error('This payment can no longer be verified');
    },

    /**
     * Razorpay webhook (payment.captured / order.paid).
     *
     * The app confirms a payment by calling /verify after checkout. If the app is
     * killed first - common on mobile, where UPI hands off to another app - the
     * money is taken but nothing confirms it, so no ticket is issued. Razorpay
     * also reports the payment here, server to server, and this completes the
     * order: confirm the payment, then issue the ticket or apply it to the booking.
     * Everything here is idempotent with the /verify path.
     *
     * Returns { status, body } for the route. A non-2xx makes Razorpay retry, so
     * that is reserved for failures a retry can fix.
     */
    async handleWebhook(rawBody, signature) {
        const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (!secret) {
            return { status: 503, body: { error: 'Webhook not configured' } };
        }
        const expected = crypto.createHmac('sha256', secret).update(rawBody || '').digest('hex');
        if (!signaturesMatch(expected, signature)) {
            return { status: 400, body: { error: 'Invalid signature' } };
        }

        let event;
        try {
            event = JSON.parse(rawBody.toString('utf8'));
        } catch {
            return { status: 400, body: { error: 'Invalid payload' } };
        }
        if (event.event !== 'payment.captured' && event.event !== 'order.paid') {
            return { status: 200, body: { ignored: event.event } };
        }

        const entity = event.payload?.payment?.entity;
        if (!entity || typeof entity.order_id !== 'string' || typeof entity.id !== 'string') {
            return { status: 200, body: { ignored: 'no payment entity' } };
        }

        const payment = await Payment.findOne({ gatewayOrderId: entity.order_id });
        if (!payment) {
            return { status: 200, body: { ignored: 'unknown order' } };
        }
        // The order was created server-side for this amount; anything else is not
        // ours to confirm.
        if (entity.amount !== toPaise(payment.totalAmount || payment.amount)) {
            console.error(`Webhook amount ${entity.amount} does not match payment ${payment._id}`);
            return { status: 200, body: { ignored: 'amount mismatch' } };
        }

        const confirmed = await confirmPayment(payment._id, entity.id);
        if (!confirmed) {
            console.error(`Webhook could not confirm payment ${payment._id} (status ${payment.status})`);
            return { status: 200, body: { ignored: 'not confirmable' } };
        }

        await fulfilConfirmedPayment(confirmed);
        return { status: 200, body: { ok: true } };
    },

    // Get all payouts
    async getAllPayouts(query = {}) {
        const { page = 1, limit = 10, status } = query;
        const filter = {};
        if (status) filter.status = status;

        const payouts = await Payout.find(filter)
            .populate('recipient', 'name email')
            .limit(limit * 1)
            .skip((page - 1) * limit)
            .sort({ createdAt: -1 });

        const total = await Payout.countDocuments(filter);

        return {
            payouts,
            totalPages: Math.ceil(total / limit),
            currentPage: page,
            total
        };
    },

    // Raise a payout (manual, not yet disbursed).
    //
    // The amount is exactly what the admin typed. There is no automatic
    // commission: any cut is agreed with the owner directly and is already
    // reflected in the typed amount. The owner's share before any such cut is
    // shown to the admin as a reference (earningsService.getListingFigures
    // ownerShare: full price minus the owner's own discounts).
    // `grossAmount` is accepted as the older name for `amount`.
    async processPayout({ recipientId, type, referenceId, referenceModel, amount, grossAmount, initiatedBy = null, notes = null }) {
        const typed = Number(amount ?? grossAmount);
        if (!Number.isFinite(typed) || typed <= 0) {
            throw new Error('Payout amount must be a positive number');
        }
        const netAmount = roundMoney(typed);

        // Bank details are authoritative from the owner, not the caller. Fail
        // closed if the owner has no valid stored details — a payout must be
        // tied to real, valid bank details.
        const owner = await User.findById(recipientId).select('bankDetails bankAccounts');

        // Prefer the account the listing itself named, falling back to the owner's
        // default (mirrored into bankDetails). This is what makes "pay this venue's
        // earnings into a different account" actually take effect, while every
        // listing created before payoutAccount existed keeps using the default.
        const chosen = await resolveListingPayoutAccount({ owner, referenceId, referenceModel });
        const bankDetails = chosen || (owner && owner.bankDetails);

        if (!isValidBankDetails(bankDetails)) {
            throw new Error('Recipient has no valid bank details on file; cannot process payout');
        }

        const payout = await Payout.create({
            recipient: recipientId,
            type,
            referenceId,
            referenceModel,
            grossAmount: netAmount,
            platformCommission: 0,
            platformCommissionPercentage: 0,
            netAmount,
            initiatedBy,
            notes,
            // Snapshot, not a reference: a payout records where the money actually
            // went, so deleting the account later must not rewrite history.
            bankDetails: {
                accountName: bankDetails.accountName,
                accountNumber: bankDetails.accountNumber,
                ifscCode: bankDetails.ifscCode,
                bankName: bankDetails.bankName,
            },
            method: 'manual',
            gatewayPayoutId: null,
            status: 'pending'
        });

        return payout;
    }
};

module.exports = paymentService;
