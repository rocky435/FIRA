// @ts-check
/**
 * Venue pricing on the server. A venue has a day rate (required, above 0) and
 * optional demand pricing the owner sets:
 *   - a weekend rate, for Saturdays and Sundays;
 *   - special-date rates, for festivals, wedding season or any peak day.
 * A special date beats the weekend rate, which beats the day rate. A booking's
 * total is the sum of each day's rate. Mirrored by client/src/lib/venuePricing.ts.
 */

const { roundMoney } = require('./money');

const MAX_SPECIAL_DATES = 366;
const MAX_DAY_RATE = 10_000_000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The plain day rate. Venues saved before pricePerDay existed only have basePrice.
 * @param {any} venue
 * @returns {number}
 */
function baseDayRate(venue) {
    const p = (venue && venue.pricing) || {};
    return Number(p.pricePerDay ?? p.basePrice ?? 0) || 0;
}

/**
 * The rate for one day ('YYYY-MM-DD').
 * @param {any} venue
 * @param {string} key
 * @returns {number}
 */
function priceForDay(venue, key) {
    const p = (venue && venue.pricing) || {};
    const special = (p.specialDates || []).find((/** @type {any} */ d) => d && d.date === key);
    if (special && Number(special.pricePerDay) > 0) return Number(special.pricePerDay);
    const weekday = new Date(`${key}T00:00:00Z`).getUTCDay();
    if ((weekday === 0 || weekday === 6) && Number(p.weekendPricePerDay) > 0) return Number(p.weekendPricePerDay);
    return baseDayRate(venue);
}

/**
 * The total for a booking covering these days.
 * @param {any} venue
 * @param {string[]} dayKeys
 * @returns {number}
 */
function bookingTotal(venue, dayKeys) {
    return roundMoney(dayKeys.reduce((sum, key) => sum + priceForDay(venue, key), 0));
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function rate(value, label) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_DAY_RATE) {
        throw new Error(`${label} must be a price above ₹0`);
    }
    return roundMoney(n);
}

/**
 * Check and tidy the pricing an owner sends. Throws a readable error for a
 * missing or zero day rate or a bad demand price. Returns the object to store.
 *
 * @param {any} pricing
 */
function normalisePricing(pricing) {
    const p = pricing && typeof pricing === 'object' ? pricing : {};
    const day = rate(p.pricePerDay ?? p.basePrice, 'The day rate');
    const weekendRaw = p.weekendPricePerDay;
    const weekend = weekendRaw == null || weekendRaw === '' || Number(weekendRaw) === 0
        ? null
        : rate(weekendRaw, 'The weekend rate');

    if (p.specialDates != null && !Array.isArray(p.specialDates)) {
        throw new Error('Special-date prices must be a list');
    }
    /** @type {Map<string, number>} */
    const byDate = new Map();
    for (const entry of p.specialDates || []) {
        const date = entry && typeof entry.date === 'string' ? entry.date.slice(0, 10) : '';
        if (!DAY_KEY.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
            throw new Error('Each special-date price needs a valid date');
        }
        byDate.set(date, rate(entry.pricePerDay, `The price for ${date}`));
    }
    if (byDate.size > MAX_SPECIAL_DATES) {
        throw new Error(`At most ${MAX_SPECIAL_DATES} special-date prices`);
    }

    return {
        pricePerDay: day,
        // Mirrors the day rate for anything still reading the old field.
        basePrice: day,
        weekendPricePerDay: weekend,
        specialDates: [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, pricePerDay]) => ({ date, pricePerDay })),
        currency: typeof p.currency === 'string' && p.currency ? p.currency : 'INR',
    };
}

module.exports = { baseDayRate, priceForDay, bookingTotal, normalisePricing, MAX_SPECIAL_DATES };
