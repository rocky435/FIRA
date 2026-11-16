const { roundMoney } = require('./money');

/**
 * FIRA's commission on what an organiser or venue owner earns.
 *
 * Separate from the platform fee buyers pay on top of the price
 * (platformFeePercentage): this one comes out of the owner's share when FIRA
 * pays them. It is set per person by an admin and copied onto each of their
 * listings, where an admin can change it for that listing alone.
 *
 * Admin-only for now: nothing here is sent to owners or the website.
 */

/**
 * A rate as an admin typed it: a number from 0 to 100 with at most two
 * decimals, or null/'' meaning "no rate". Throws on anything else, with a
 * message fit to show.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function parseRate(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n) || n < 0 || n > 100) {
        throw new Error('Commission must be a number from 0 to 100');
    }
    if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-9) {
        throw new Error('Commission can have at most two decimal places');
    }
    return Math.round(n * 100) / 100;
}

/**
 * The deduction for an owner's share at a rate.
 *
 * The commission is rounded to paise. What is left to pay is in whole rupees,
 * because settlements are recorded in whole rupees (the same floor the money
 * path already applied to the owner's share).
 *
 *   ₹20,000 at 4%  ->  amount ₹800, netPayable ₹19,200
 *
 * @param {number} ownerShare
 * @param {number | null | undefined} percentage
 * @returns {{ percentage: number, amount: number, netPayable: number }}
 */
function commissionOn(ownerShare, percentage) {
    const share = Number.isFinite(ownerShare) ? ownerShare : 0;
    const pct = Number.isFinite(percentage) && percentage > 0 ? Math.min(100, percentage) : 0;
    const amount = roundMoney(share * pct / 100);
    return {
        percentage: pct,
        amount,
        netPayable: Math.max(0, Math.floor(roundMoney(share - amount))),
    };
}

/**
 * The rate a new listing starts with: its owner's, or null (0%) when the owner
 * has none or cannot be read. Never throws - a listing must not fail to be
 * created over this.
 *
 * @param {any} ownerId
 * @returns {Promise<number | null>}
 */
async function ownerRate(ownerId) {
    try {
        if (!ownerId) return null;
        const User = require('../models/User');
        const owner = await User.findById(ownerId).select('+commissionPercentage').lean();
        const rate = owner ? owner.commissionPercentage : null;
        return Number.isFinite(rate) ? rate : null;
    } catch (err) {
        console.error('Could not read the owner commission rate:', err.message);
        return null;
    }
}

module.exports = { parseRate, commissionOn, ownerRate };
