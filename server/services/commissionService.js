const mongoose = require('mongoose');
const User = require('../models/User');
const Event = require('../models/Event');
const Venue = require('../models/Venue');
const Settlement = require('../models/Settlement');
const { parseRate, commissionOn } = require('../utils/commission');
const { formatInr } = require('../utils/formatInr');

/**
 * Setting FIRA's commission on what organisers and venue owners earn
 * (utils/commission.js has the maths; earningsService applies it).
 *
 * Two levels:
 *  - a person's rate (User.commissionPercentage), which their new listings
 *    copy and which is pushed onto their existing listings when it is set;
 *  - one listing's rate (Event/Venue.commissionPercentage), which an admin can
 *    set by hand for that listing alone (commissionCustom).
 *
 * A rate change never rewrites a payout that already happened: a person's new
 * rate skips listings that have been paid anything, and a listing's own rate
 * cannot be raised to the point where less is owed than was already paid.
 *
 * Admin-only. Nothing here is returned to owners or the website.
 */

const KINDS = {
    event: { Model: Event, ownerField: 'organizer', label: 'event' },
    venue: { Model: Venue, ownerField: 'owner', label: 'venue' },
};

function fail(status, message, extra = {}) {
    return Object.assign(new Error(message), { status }, extra);
}

function specFor(kind) {
    const spec = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
    if (!spec) throw fail(404, 'Listing not found');
    return spec;
}

/** Parse a typed rate, as a 400 with the message to show. */
function rateFrom(value) {
    try {
        return parseRate(value);
    } catch (err) {
        throw fail(400, err.message, { field: 'percentage' });
    }
}

const commissionService = {
    /**
     * A listing's commission for the admin's settlement panel: its rate, whether
     * that was set on the listing by hand, and its owner's own rate.
     *
     * @param {string} kind
     * @param {any} listingId
     */
    async describeListing(kind, listingId) {
        const spec = specFor(kind);
        if (!mongoose.isValidObjectId(listingId)) throw fail(404, 'Listing not found');
        const doc = /** @type {any} */ (await spec.Model.findById(listingId)
            .select(`${spec.ownerField} +commissionPercentage +commissionCustom`).lean());
        if (!doc) throw fail(404, 'Listing not found');
        const owner = doc[spec.ownerField]
            ? /** @type {any} */ (await User.findById(doc[spec.ownerField]).select('name +commissionPercentage').lean())
            : null;
        return {
            percentage: commissionOn(0, doc.commissionPercentage).percentage,
            custom: doc.commissionCustom === true,
            owner: owner
                ? { id: String(owner._id), name: owner.name || '', percentage: owner.commissionPercentage ?? null }
                : null,
        };
    },

    /**
     * Set one listing's rate. `percentage` null/'' puts it back on its owner's
     * rate. Refused when the new rate would leave less owed than has already
     * been paid - reverse a settlement or choose a lower rate instead.
     *
     * @param {{ kind: string, listingId: any, percentage: unknown, adminUserId: any }} params
     * @returns {Promise<object>} the listing's settlement, as the admin panel reads it
     */
    async setListingRate({ kind, listingId, percentage, adminUserId }) {
        const spec = specFor(kind);
        const rate = rateFrom(percentage);
        const settlementService = require('./settlementService');
        // Also the existence check: an unknown listing is a 404 from here.
        const current = await settlementService.getListingSettlement({ kind, listingId });

        const custom = rate !== null;
        const next = custom ? rate : (current.commission.owner?.percentage ?? null);
        const nextNet = commissionOn(current.money.ownerShare, next).netPayable;
        if (current.money.settledToDate - nextNet > 0.01) {
            throw fail(409,
                `${formatInr(current.money.settledToDate)} has already been paid for this ${spec.label}. At ${commissionOn(0, next).percentage}% only ${formatInr(nextNet)} would be owed. Choose a lower rate, or reverse a settlement first.`,
                { field: 'percentage', code: 'below_settled' });
        }

        await spec.Model.updateOne({ _id: listingId }, { $set: { commissionPercentage: next, commissionCustom: custom } });

        await require('./adminService').recordAdminAction({
            adminUser: adminUserId,
            action: 'update',
            entityType: kind,
            entityId: listingId,
            metadata: {
                name: current.listing.name,
                field: 'commissionPercentage',
                from: current.commission.percentage,
                to: commissionOn(0, next).percentage,
                setOnListing: custom,
            },
        });

        return settlementService.getListingSettlement({ kind, listingId });
    },

    /**
     * A person's commission: their rate and how their listings stand.
     *
     * @param {any} userId
     */
    async describeOwner(userId) {
        if (!mongoose.isValidObjectId(userId)) throw fail(404, 'User not found');
        const user = /** @type {any} */ (await User.findById(userId).select('name +commissionPercentage').lean());
        if (!user) throw fail(404, 'User not found');
        const listings = await ownerListings(userId);
        return {
            percentage: user.commissionPercentage ?? null,
            listings: listings.map(({ kind, id, name, percentage, custom, paid }) => ({ kind, id, name, percentage, custom, paid })),
        };
    },

    /**
     * Set a person's rate. It becomes the starting rate of their future
     * listings, and is applied now to their existing ones - except those with a
     * rate set by hand and those already paid something, which are reported back
     * as `kept` so the admin can change them one by one if they mean to.
     *
     * @param {{ userId: any, percentage: unknown, adminUserId: any }} params
     */
    async setOwnerRate({ userId, percentage, adminUserId }) {
        const rate = rateFrom(percentage);
        if (!mongoose.isValidObjectId(userId)) throw fail(404, 'User not found');
        const user = /** @type {any} */ (await User.findById(userId).select('name email +commissionPercentage').lean());
        if (!user) throw fail(404, 'User not found');

        await User.updateOne({ _id: userId }, { $set: { commissionPercentage: rate } });

        const listings = await ownerListings(userId);
        const applied = [];
        const kept = [];
        for (const item of listings) {
            const brief = { kind: item.kind, id: item.id, name: item.name };
            if (item.custom) kept.push({ ...brief, percentage: item.percentage, reason: 'custom' });
            else if (item.paid) kept.push({ ...brief, percentage: item.percentage, reason: 'paid' });
            else applied.push(brief);
        }
        for (const kind of Object.keys(KINDS)) {
            const ids = applied.filter((a) => a.kind === kind).map((a) => a.id);
            if (ids.length) await KINDS[kind].Model.updateMany({ _id: { $in: ids } }, { $set: { commissionPercentage: rate } });
        }

        await require('./adminService').recordAdminAction({
            adminUser: adminUserId,
            action: 'update',
            entityType: 'user',
            entityId: userId,
            metadata: {
                name: user.name,
                email: user.email,
                field: 'commissionPercentage',
                from: user.commissionPercentage ?? null,
                to: rate,
                listingsUpdated: applied.length,
                listingsKept: kept.length,
            },
        });

        return { percentage: rate, applied, kept };
    },
};

/**
 * Every event and venue a person owns (removed ones too - they can still be
 * owed money), with its rate, whether that was set by hand, and whether
 * anything has been paid for it (net of reversals).
 *
 * @param {any} userId
 */
async function ownerListings(userId) {
    const out = [];
    for (const [kind, spec] of Object.entries(KINDS)) {
        const docs = /** @type {any[]} */ (await spec.Model.find({ [spec.ownerField]: userId })
            .select('name +commissionPercentage +commissionCustom').lean());
        if (!docs.length) continue;
        const paidRows = await Settlement.aggregate([
            { $match: /** @type {any} */ ({ listingKind: kind, listing: { $in: docs.map((d) => d._id) } }) },
            { $group: { _id: '$listing', settled: { $sum: '$settledAmount' } } },
        ]);
        const paid = new Set(paidRows.filter((r) => r.settled > 0.01).map((r) => String(r._id)));
        for (const doc of docs) {
            out.push({
                kind,
                id: String(doc._id),
                name: doc.name || '',
                percentage: commissionOn(0, doc.commissionPercentage).percentage,
                custom: doc.commissionCustom === true,
                paid: paid.has(String(doc._id)),
            });
        }
    }
    return out;
}

module.exports = commissionService;
