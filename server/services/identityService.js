const mongoose = require('mongoose');
const User = require('../models/User');

/**
 * Identity checks reviewed by hand in the admin app.
 *
 * Two independent checks, same lifecycle:
 *   - 'gov-id': a venue owner's government ID. A venue cannot be approved
 *     until its owner's ID is verified.
 *   - 'pan':    an event organiser's PAN. Their event earnings cannot be
 *     recorded as paid out until it is verified.
 *
 * Status: 'none' (nothing submitted) -> 'pending' (submitted, or re-submitted)
 * -> 'verified' | 'rejected' (by an admin, a rejection always carrying the
 * reason the user is shown). Submitting again from any state goes back to
 * 'pending', so a changed document is always looked at again.
 *
 * Accounts from before this existed have a document but no status; they read
 * as 'pending' (or 'verified' when the old govIdVerified flag is set) without a
 * migration.
 */

const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GOV_ID_TYPES = ['aadhar', 'pan', 'driving_license', 'passport', 'voter_id'];
const MAX_REASON_LENGTH = 500;

const KINDS = {
    'gov-id': {
        label: 'government ID',
        status: 'govIdStatus',
        number: 'govIdNumber',
        document: 'govIdDocument',
        reason: 'govIdRejectionReason',
        reviewedAt: 'govIdReviewedAt',
        reviewedBy: 'govIdReviewedBy',
    },
    pan: {
        label: 'PAN',
        status: 'panStatus',
        number: 'panNumber',
        document: 'panDocument',
        reason: 'panRejectionReason',
        reviewedAt: 'panReviewedAt',
        reviewedBy: 'panReviewedBy',
    },
};

// Everything any read here needs, so one select serves all of them.
const IDENTITY_FIELDS = 'name email govIdType govIdVerified ' + Object.values(KINDS)
    .flatMap(k => [k.status, k.number, k.document, k.reason, k.reviewedAt, k.reviewedBy])
    .join(' ');

function fail(status, message, field) {
    const error = /** @type {Error & { status?: number, field?: string }} */ (new Error(message));
    error.status = status;
    if (field) error.field = field;
    return error;
}

function specFor(kind) {
    const spec = KINDS[kind];
    if (!spec) throw fail(404, 'Unknown identity check');
    return spec;
}

/**
 * Documents are uploaded through /upload into the private gov-ids folder. Only
 * accept those, so a submission cannot point at a public image elsewhere (or
 * someone else's file on another host).
 */
function isPrivateDocumentUrl(url) {
    return typeof url === 'string'
        && /^https:\/\/res\.cloudinary\.com\//.test(url)
        && url.includes('/fira/gov-ids/');
}

function lastFour(value) {
    if (!value) return null;
    const s = String(value);
    return s.length <= 4 ? s : s.slice(-4);
}

const identityService = {
    KINDS,
    PAN_PATTERN,

    /** The effective status of one check, legacy accounts included. */
    statusOf(user, kind) {
        const spec = specFor(kind);
        if (!user) return 'none';
        const stored = user[spec.status];
        if (stored && stored !== 'none') return stored;
        if (kind === 'gov-id' && user.govIdVerified === true) return 'verified';
        return user[spec.number] || user[spec.document] ? 'pending' : 'none';
    },

    async isVerified(userId, kind) {
        if (!userId || !mongoose.isValidObjectId(String(userId))) return false;
        const user = await User.findById(userId).select(IDENTITY_FIELDS).lean();
        return identityService.statusOf(user, kind) === 'verified';
    },

    /** What a user sees about their own checks: status and reason, never the full number. */
    ownView(user) {
        const view = {};
        for (const kind of Object.keys(KINDS)) {
            const spec = KINDS[kind];
            view[kind === 'gov-id' ? 'govId' : 'pan'] = {
                status: identityService.statusOf(user, kind),
                ...(kind === 'gov-id' ? { type: user.govIdType || null } : {}),
                numberLast4: lastFour(user[spec.number]),
                hasDocument: Boolean(user[spec.document]),
                rejectionReason: user[spec.reason] || null,
                reviewedAt: user[spec.reviewedAt] || null,
            };
        }
        return view;
    },

    async getOwn(userId) {
        const user = await User.findById(userId).select(IDENTITY_FIELDS).lean();
        if (!user) throw fail(404, 'Account not found');
        return identityService.ownView(user);
    },

    /** Submit or replace the government ID. Always goes (back) to 'pending'. */
    async submitGovId(userId, { govIdType, govIdNumber, govIdDocument } = {}) {
        if (!GOV_ID_TYPES.includes(govIdType)) throw fail(400, 'Choose an ID type', 'govIdType');
        const number = typeof govIdNumber === 'string' ? govIdNumber.trim().toUpperCase() : '';
        if (number.length < 4 || number.length > 30) throw fail(400, 'Enter your ID number', 'govIdNumber');
        if (govIdType === 'pan' && !PAN_PATTERN.test(number)) {
            throw fail(400, 'Enter a valid PAN, like ABCDE1234F', 'govIdNumber');
        }
        if (!isPrivateDocumentUrl(govIdDocument)) throw fail(400, 'Upload a photo of your ID', 'govIdDocument');

        return identityService._submit(userId, 'gov-id', {
            govIdType,
            govIdNumber: number,
            govIdDocument,
            govIdVerified: false,
        });
    },

    /** Submit or replace the PAN. Always goes (back) to 'pending'. */
    async submitPan(userId, { panNumber, panDocument } = {}) {
        const number = typeof panNumber === 'string' ? panNumber.trim().toUpperCase() : '';
        if (!PAN_PATTERN.test(number)) throw fail(400, 'Enter a valid PAN, like ABCDE1234F', 'panNumber');
        if (!isPrivateDocumentUrl(panDocument)) throw fail(400, 'Upload a photo of your PAN card', 'panDocument');

        return identityService._submit(userId, 'pan', { panNumber: number, panDocument });
    },

    async _submit(userId, kind, fields) {
        const spec = KINDS[kind];
        // Through a document save, not an update query: the number is encrypted
        // by a schema setter, which update queries do not run.
        const user = await User.findById(userId);
        if (!user) throw fail(404, 'Account not found');
        user.set({
            ...fields,
            [spec.status]: 'pending',
            [spec.reason]: null,
            [spec.reviewedAt]: null,
            [spec.reviewedBy]: null,
        });
        await user.save();
        return identityService.ownView(user);
    },

    /** The admin's view of one user: full numbers and 10-minute document links. */
    async getForAdmin(userId) {
        if (!mongoose.isValidObjectId(String(userId))) throw fail(404, 'User not found');
        const user = await User.findById(userId).select(IDENTITY_FIELDS).lean();
        if (!user) throw fail(404, 'User not found');
        return identityService.adminView(user);
    },

    adminView(user) {
        const { privateDocumentLink } = require('./uploadService');
        // A link that cannot be signed (e.g. storage not configured) shows as
        // missing rather than failing the whole read - or a review that is
        // already saved by the time this runs.
        const link = (url) => {
            if (!url) return null;
            try {
                return privateDocumentLink(url);
            } catch (error) {
                console.error('Could not sign ID document link:', error.message);
                return null;
            }
        };
        return {
            _id: user._id,
            name: user.name,
            email: user.email,
            govId: {
                status: identityService.statusOf(user, 'gov-id'),
                type: user.govIdType || null,
                number: user.govIdNumber || null,
                documentUrl: link(user.govIdDocument),
                rejectionReason: user.govIdRejectionReason || null,
                reviewedAt: user.govIdReviewedAt || null,
            },
            pan: {
                status: identityService.statusOf(user, 'pan'),
                number: user.panNumber || null,
                documentUrl: link(user.panDocument),
                rejectionReason: user.panRejectionReason || null,
                reviewedAt: user.panReviewedAt || null,
            },
        };
    },

    /** Everyone with at least one check waiting for review, oldest change first. */
    async listPending({ limit = 100 } = {}) {
        const unset = { $in: [null, 'none'] };
        const has = (field) => ({ [field]: { $nin: [null, ''] } });
        const users = await User.find({
            $or: [
                { govIdStatus: 'pending' },
                { panStatus: 'pending' },
                // Legacy rows: a document with no status yet reads as pending.
                { govIdStatus: unset, govIdVerified: { $ne: true }, $or: [has('govIdNumber'), has('govIdDocument')] },
                { panStatus: unset, $or: [has('panNumber'), has('panDocument')] },
            ],
        })
            .select(IDENTITY_FIELDS)
            .sort({ updatedAt: 1 })
            .limit(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200))
            .lean();
        return users.map(u => identityService.adminView(u));
    },

    /**
     * Verify or reject one check. Rejecting needs the reason the user is shown.
     * Audited and notified; an admin cannot review their own documents.
     */
    async review(userId, kind, { action, reason } = {}, adminUserId) {
        const spec = specFor(kind);
        if (!['verify', 'reject'].includes(action)) throw fail(400, "Action must be 'verify' or 'reject'");
        const cleanReason = typeof reason === 'string' ? reason.trim() : '';
        if (action === 'reject' && !cleanReason) throw fail(400, 'Give a reason - the user is shown it', 'reason');
        if (cleanReason.length > MAX_REASON_LENGTH) throw fail(400, `Keep the reason under ${MAX_REASON_LENGTH} characters`, 'reason');
        if (!mongoose.isValidObjectId(String(userId))) throw fail(404, 'User not found');
        if (adminUserId && String(adminUserId) === String(userId)) {
            throw fail(403, 'You cannot review your own documents');
        }

        const user = await User.findById(userId);
        if (!user) throw fail(404, 'User not found');
        const from = identityService.statusOf(user, kind);
        if (from === 'none') throw fail(400, `This user has not submitted a ${spec.label}`);

        const to = action === 'verify' ? 'verified' : 'rejected';
        user.set({
            [spec.status]: to,
            [spec.reason]: action === 'reject' ? cleanReason : null,
            [spec.reviewedAt]: new Date(),
            [spec.reviewedBy]: adminUserId || null,
            ...(kind === 'gov-id' ? { govIdVerified: to === 'verified' } : {}),
        });
        await user.save();

        const adminService = require('./adminService');
        await adminService.recordAdminAction({
            adminUser: adminUserId,
            action: action === 'verify' ? 'approve' : 'reject',
            entityType: 'user',
            entityId: user._id,
            metadata: {
                name: user.name,
                email: user.email,
                field: spec.status,
                from,
                to,
                ...(action === 'reject' ? { reason: cleanReason } : {}),
            },
        });

        // Best-effort: the decision is saved whether or not the alert goes out.
        try {
            const notificationService = require('./notificationService');
            await notificationService.createNotification({
                userId: user._id,
                type: action === 'verify' ? 'verification_approved' : 'verification_rejected',
                title: action === 'verify' ? `Your ${spec.label} is verified` : `Your ${spec.label} was not accepted`,
                message: action === 'verify'
                    ? `Thanks - your ${spec.label} has been checked and verified.`
                    : `Reason: ${cleanReason}. Please upload it again from Settings.`,
                data: { actionUrl: '/dashboard/settings', extra: { check: kind } },
                priority: action === 'verify' ? 'medium' : 'high',
                channel: 'all',
            });
        } catch (error) {
            console.error('Identity review notification failed:', error.message);
        }

        return identityService.adminView(user.toObject());
    },
};

module.exports = identityService;
