const Refund = require('../models/Refund');
const Payment = require('../models/Payment');
const Ticket = require('../models/Ticket');
const Event = require('../models/Event');
const Booking = require('../models/Booking');
const notificationService = require('./notificationService');
const { roundMoney } = require('../utils/money');

/**
 * When an event starts. `startDateTime` is the schema field; `date` is kept as a
 * fallback for any legacy document that still carries it.
 */
const eventStart = (event) => (event && (event.startDateTime || event.date)) || null;

/**
 * Refund Service
 * Refund requests (raised on cancellations) and the admin decisions on them.
 * Refunds are paid manually; nothing here calls the payment gateway.
 */
const refundService = {
    /**
     * Calculate refund amount based on time-based policy
     * @param {number} originalAmount - Original payment amount
     * @param {Date} eventDate - Event date
     * @returns {object} - { amount, refundType, policy }
     */
    calculateRefundAmount(originalAmount, eventDate) {
        const now = new Date();
        const eventTime = new Date(eventDate);
        const hoursUntilEvent = (eventTime - now) / (1000 * 60 * 60);

        let refundPercentage = 0;
        let refundType = 'none';
        let policy = '';

        if (hoursUntilEvent >= 48) {
            refundPercentage = 100;
            refundType = 'full';
            policy = 'Full refund (48+ hours before event)';
        } else if (hoursUntilEvent >= 24) {
            refundPercentage = 50;
            refundType = 'partial';
            policy = '50% refund (24-48 hours before event)';
        } else {
            refundPercentage = 0;
            refundType = 'none';
            policy = 'No refund (less than 24 hours before event)';
        }

        return {
            amount: roundMoney(originalAmount * (refundPercentage / 100)),
            refundType,
            policy,
            refundPercentage
        };
    },

    /**
     * Raise a refund request for admin approval.
     *
     * Every refund waits for an admin: this records a 'pending' Refund and moves
     * no money. The money moves only in processRefundRequest, when an admin
     * approves. (This used to refund through Razorpay immediately - and, with no
     * gateway configured, marked the refund 'completed' without paying anything.)
     *
     * @param {string} paymentId - Payment document ID
     * @param {object} options - { amount, reason, reasonDetails, refundType, userId }
     * @returns {object} - Refund record (status 'pending')
     */
    async processRefund(paymentId, { amount, reason, reasonDetails, refundType = 'full', userId }) {
        const payment = await Payment.findById(paymentId);
        if (!payment) {
            throw new Error('Payment not found');
        }

        if (payment.status !== 'success') {
            throw new Error('Can only refund successful payments');
        }

        // One open or completed refund per payment.
        const existingRefund = await Refund.findOne({
            payment: paymentId,
            status: { $in: ['pending', 'approved', 'processing', 'completed'] }
        });
        if (existingRefund) {
            throw new Error('Refund already exists for this payment');
        }

        // Validate refund amount
        const refundAmount = amount == null ? payment.amount : roundMoney(Number(amount));
        if (!Number.isFinite(refundAmount) || refundAmount <= 0 || refundAmount > payment.amount) {
            throw new Error('Refund amount must be more than zero and no more than the payment amount');
        }

        return Refund.create({
            payment: paymentId,
            user: userId || payment.user,
            reason,
            reasonDetails,
            amount: refundAmount,
            refundType: refundAmount === payment.amount ? 'full' : 'partial',
            status: 'pending'
        });
    },

    /**
     * Initiate refunds for all tickets when an event is cancelled
     * @param {string} eventId - Event ID
     * @param {string} reason - Cancellation reason
     * @returns {object} - { totalRefunds, successCount, failedCount, refunds }
     */
    async initiateEventCancellationRefunds(eventId, reason = 'Event cancelled by organizer') {
        const event = await Event.findById(eventId);
        if (!event) {
            throw new Error('Event not found');
        }

        // Find all active tickets for this event
        const tickets = await Ticket.find({ 
            event: eventId, 
            status: 'active' 
        }).populate('payment user');

        const results = {
            totalRefunds: tickets.length,
            successCount: 0,
            failedCount: 0,
            refunds: []
        };

        for (const ticket of tickets) {
            try {
                // Skip if no payment (free ticket)
                if (!ticket.payment || ticket.price === 0) {
                    // Just cancel the ticket
                    ticket.status = 'cancelled';
                    await ticket.save();
                    results.successCount++;
                    continue;
                }

                // Process full refund for paid tickets
                const refund = await this.processRefund(ticket.payment._id || ticket.payment, {
                    amount: ticket.price,
                    reason: 'event_cancelled',
                    reasonDetails: reason,
                    refundType: 'full',
                    userId: ticket.user._id || ticket.user
                });

                // Update ticket status
                ticket.status = 'cancelled';
                await ticket.save();

                // Send notification to user
                // Fire-and-forget: the ticket/refund is already committed at this
        // point, so a notification failure must not surface as a failed
        // cancellation. (A missing enum value here previously did exactly
        // that - the ticket cancelled, then the request errored, and the
        // retry reported "Ticket is not active".)
        notificationService.createNotification({
                    userId: ticket.user._id || ticket.user,
                    type: 'refund',
                    title: 'Event cancelled - refund requested',
                    message: `The event "${event.name}" has been cancelled. A refund of ₹${refund.amount} has been requested and will be sent once approved.`,
                    data: { eventId, refundId: refund._id, amount: refund.amount },
                    priority: 'high'
                });

                results.refunds.push(refund);
                results.successCount++;
            } catch (error) {
                console.error(`Failed to refund ticket ${ticket._id}:`, error.message);
                results.failedCount++;
            }
        }

        // Update event attendee count
        await Event.findByIdAndUpdate(eventId, {
            $set: { currentAttendees: 0 }
        }).catch(err => console.error('Notification failed (non-fatal):', err.message));

        return results;
    },

    /**
     * Initiate refund for a single ticket cancellation
     * @param {string} ticketId - Ticket ID
     * @param {string} userId - User requesting cancellation
     * @param {string} reason - Cancellation reason
     * @returns {object} - { ticket, refund, refundEligibility }
     */
    async initiateTicketRefund(ticketId, userId, reason = 'User requested cancellation') {
        const ticket = await Ticket.findById(ticketId)
            .populate('event')
            .populate('payment');

        if (!ticket) {
            throw new Error('Ticket not found');
        }

        if (ticket.user.toString() !== userId.toString()) {
            throw new Error('Unauthorized: This ticket belongs to another user');
        }

        if (ticket.status !== 'active') {
            throw new Error('Ticket is not active');
        }

        if (ticket.isUsed) {
            throw new Error('Cannot cancel used ticket');
        }

        // Calculate refund eligibility. The Event schema has no `date` path -
        // reading it made every cancellation look "under 24 hours" and refund
        // nothing, whatever the policy said.
        const refundEligibility = this.calculateRefundAmount(ticket.price, eventStart(ticket.event));

        // Claim the cancellation atomically before any money moves, so two quick
        // cancel requests can't both pass the 'active' check and refund twice.
        const claimed = await Ticket.findOneAndUpdate(
            { _id: ticket._id, status: 'active', isUsed: { $ne: true } },
            { $set: { status: 'cancelled' } }
        );
        if (!claimed) {
            throw new Error('Ticket is not active');
        }

        let refund = null;

        // Process refund if eligible and ticket was paid
        if (refundEligibility.amount > 0 && ticket.payment && ticket.price > 0) {
            try {
                refund = await this.processRefund(ticket.payment._id || ticket.payment, {
                    amount: refundEligibility.amount,
                    reason: 'user_request',
                    reasonDetails: reason,
                    refundType: refundEligibility.refundType,
                    userId
                });
            } catch (error) {
                // Nothing was refunded - give the ticket back so the holder can retry.
                await Ticket.updateOne({ _id: ticket._id, status: 'cancelled' }, { $set: { status: 'active' } });
                throw error;
            }
        }

        ticket.status = 'cancelled';

        // Decrease event attendee count
        await Event.findByIdAndUpdate(ticket.event._id, {
            $inc: { currentAttendees: -ticket.quantity }
        });

        // Send notification
        // Fire-and-forget: the ticket/refund is already committed at this
        // point, so a notification failure must not surface as a failed
        // cancellation. (A missing enum value here previously did exactly
        // that - the ticket cancelled, then the request errored, and the
        // retry reported "Ticket is not active".)
        notificationService.createNotification({
            userId,
            type: 'ticket_cancelled',
            title: 'Ticket cancelled',
            message: refund 
                ? `Your ticket for "${ticket.event.name}" has been cancelled. A refund of ₹${refund.amount} (${refundEligibility.policy}) has been requested and will be sent once approved.`
                : `Your ticket for "${ticket.event.name}" has been cancelled. ${refundEligibility.policy}`,
            data: { ticketId, eventId: ticket.event._id, refundId: refund?._id },
            priority: 'medium'
        }).catch(err => console.error('Notification failed (non-fatal):', err.message));

        return {
            ticket,
            refund,
            refundEligibility
        };
    },

    /**
     * Raise refund requests for what a guest actually paid on a booking: the
     * deposit (or full payment), plus the balance if it was paid. The base is the
     * booking amounts only - the platform fee and GST are never refunded.
     * `percentage` comes from whoever decided the refund (100 for an owner
     * rejection or a removed venue; the venue's policy for a guest cancellation).
     * Requests only - an admin pays them from "Refunds to be done".
     *
     * @returns {Promise<{ amountPaid: number, refunds: any[] }>}
     */
    async raiseBookingRefunds(booking, percentage, { reasonDetails, userId } = {}) {
        const s = booking.paymentSchedule || {};
        const charges = [];
        if (booking.paymentStatus === 'paid' && booking.payment) {
            charges.push({
                payment: booking.payment,
                base: s.type === 'installment' ? roundMoney(s.depositAmount || 0) : roundMoney(s.depositAmount || booking.totalAmount),
            });
            if (s.type === 'installment' && s.balanceStatus === 'paid' && s.balancePayment) {
                charges.push({ payment: s.balancePayment, base: roundMoney(s.balanceAmount || 0) });
            }
        }

        const refunds = [];
        for (const { payment, base } of charges) {
            const amount = roundMoney(base * percentage / 100);
            if (!(amount > 0)) continue;
            try {
                refunds.push(await this.processRefund(payment._id || payment, {
                    amount,
                    reason: 'booking_cancelled',
                    reasonDetails,
                    userId: userId || booking.user,
                }));
            } catch (err) {
                // The booking decision stands either way; an admin sees the gap.
                console.error(`Could not raise refund for booking ${booking._id}, payment ${payment}: ${err.message}`);
            }
        }
        return { amountPaid: roundMoney(charges.reduce((sum, c) => sum + c.base, 0)), refunds };
    },

    /**
     * Get refund by ID
     * @param {string} refundId - Refund ID
     * @returns {object} - Refund document
     */
    async getRefundById(refundId) {
        const refund = await Refund.findById(refundId)
            .populate('payment')
            .populate('user', 'name email');
        
        if (!refund) {
            throw new Error('Refund not found');
        }
        
        return refund;
    },

    /**
     * Get all refunds for a user
     * @param {string} userId - User ID
     * @returns {array} - List of refunds
     */
    async getRefundsByUser(userId) {
        const refunds = await Refund.find({ user: userId })
            .populate('payment')
            .sort({ createdAt: -1 });
        
        return refunds;
    },

    /**
     * Get all refunds (admin)
     * @param {object} query - { page, limit, status }
     * @returns {object} - Paginated refunds
     */
    async getAllRefunds(query = {}) {
        const { page = 1, limit = 10, status } = query;
        const filter = {};
        if (status) filter.status = status;

        const refunds = await Refund.find(filter)
            .populate('user', 'name email')
            .populate('payment')
            .limit(limit * 1)
            .skip((page - 1) * limit)
            .sort({ createdAt: -1 });

        const total = await Refund.countDocuments(filter);

        return {
            refunds,
            totalPages: Math.ceil(total / limit),
            currentPage: page,
            total
        };
    },

    /**
     * Admin: Manually process a pending refund
     * @param {string} refundId - Refund ID
     * @param {string} adminId - Admin user ID
     * @param {string} action - 'approve' or 'reject'
     * @param {string} notes - Admin notes
     * @returns {object} - Updated refund
     */
    // action 'approve' = the admin has paid it manually; `reference` is the
    // Razorpay refund id or bank UTR it was paid under.
    async processRefundRequest(refundId, adminId, action, notes = '', reference = null) {
        if (action !== 'approve' && action !== 'reject') {
            throw new Error("Action must be 'approve' or 'reject'");
        }
        if (action === 'reject' && !String(notes || '').trim()) {
            throw new Error('A reason is required to reject a refund');
        }

        // Claim the request atomically, so two admins (or a double click) can't
        // both act on it. ('failed' is kept for requests from before refunds
        // were paid manually.)
        const refund = await Refund.findOneAndUpdate(
            { _id: refundId, status: { $in: ['pending', 'failed'] } },
            { $set: { status: 'processing', reviewedBy: adminId, reviewedAt: new Date(), adminNotes: notes } },
            { new: true }
        ).populate('payment');
        if (!refund) {
            const exists = await Refund.exists({ _id: refundId });
            throw new Error(exists ? 'Refund is not awaiting a decision' : 'Refund not found');
        }

        if (action === 'reject') {
            refund.status = 'rejected';
            refund.rejectionReason = notes;
            await refund.save();
        } else {
            // Refunds are paid manually (from the Razorpay dashboard or by bank
            // transfer); approving records that it was paid, with the reference
            // the admin paid it under. Nothing is sent from here.
            refund.status = 'completed';
            refund.processedAt = new Date();
            refund.gatewayRefundId = reference ? String(reference).trim() : null;
            refund.failureReason = null;
            await refund.save();

            if (refund.payment) {
                refund.payment.status = 'refunded';
                await refund.payment.save();
            }
        }

        const adminService = require('./adminService');
        await adminService.recordAdminAction({
            adminUser: adminId,
            action: action === 'approve' ? 'approve' : 'reject',
            entityType: 'refund',
            entityId: refund._id,
            metadata: { amount: refund.amount, payment: String(refund.payment?._id || refund.payment), result: refund.status, reference, notes },
        });

        // Tell the customer the outcome.
        if (refund.status === 'completed' || refund.status === 'rejected') {
            notificationService.createNotification({
                userId: refund.user,
                type: 'refund_update',
                title: refund.status === 'completed' ? 'Refund sent' : 'Refund not approved',
                message: refund.status === 'completed'
                    ? `Your refund of ₹${refund.amount} has been sent.${reference ? ` Reference: ${reference}.` : ''}`
                    : `Your refund request has been rejected. Reason: ${notes}`,
                data: { refundId },
                priority: 'high'
            }).catch(err => console.error('Notification failed (non-fatal):', err.message));
        }

        return refund;
    },

    /**
     * Check refund eligibility for a ticket
     * @param {string} ticketId - Ticket ID
     * @returns {object} - Refund eligibility details
     */
    async checkTicketRefundEligibility(ticketId) {
        const ticket = await Ticket.findById(ticketId).populate('event');
        
        if (!ticket) {
            throw new Error('Ticket not found');
        }

        if (ticket.status !== 'active') {
            return {
                eligible: false,
                reason: 'Ticket is not active',
                refundAmount: 0,
                policy: 'N/A'
            };
        }

        if (ticket.isUsed) {
            return {
                eligible: false,
                reason: 'Ticket has already been used',
                refundAmount: 0,
                policy: 'N/A'
            };
        }

        if (ticket.price === 0) {
            return {
                eligible: false,
                reason: 'Free tickets are not eligible for refund',
                refundAmount: 0,
                policy: 'N/A'
            };
        }

        const refundCalc = this.calculateRefundAmount(ticket.price, eventStart(ticket.event));

        return {
            eligible: refundCalc.amount > 0,
            reason: refundCalc.amount > 0 ? 'Eligible for refund' : 'Cancellation too close to event',
            refundAmount: refundCalc.amount,
            originalAmount: ticket.price,
            refundPercentage: refundCalc.refundPercentage,
            policy: refundCalc.policy,
            eventDate: eventStart(ticket.event)
        };
    }
};

module.exports = refundService;
