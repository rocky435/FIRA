/**
 * Venue pricing, resolved in one place.
 *
 * A venue is priced per day. Venues created before `pricePerDay` existed only
 * carry the old `basePrice` ("charged per booking"), so reads fall back to it -
 * which for a single-day booking is the same number it always was. Every display
 * and every total goes through here so the fallback cannot be applied
 * inconsistently, and so `pricePerHour` is dead everywhere at once.
 */

import { roundMoney } from './formatInr';

interface VenueLikePricing {
    pricing?: {
        pricePerDay?: number | null;
        basePrice?: number | null;
        // Demand pricing: a Saturday/Sunday rate and rates for particular dates.
        weekendPricePerDay?: number | null;
        specialDates?: { date: string; pricePerDay: number }[] | null;
        currency?: string;
    } | null;
}

/** The venue's per-day rate. 0 when unpriced, so callers can render "-" safely. */
export function venueDayRate(venue: VenueLikePricing | null | undefined): number {
    const pricing = venue?.pricing;
    if (!pricing) return 0;
    return pricing.pricePerDay ?? pricing.basePrice ?? 0;
}

/**
 * Nights are irrelevant for a venue: booking 5th-5th is one day, 5th-6th is two.
 * Inclusive of both end dates, and never less than 1 so a same-day booking bills
 * for the day it uses.
 */
export function billableDays(startDate: string, endDate?: string | null): number {
    if (!startDate) return 1;
    const start = new Date(startDate);
    const end = endDate ? new Date(endDate) : start;
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;

    // Compare calendar dates, not timestamps, so a time-of-day difference cannot
    // add or drop a day.
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((startOfDay(end) - startOfDay(start)) / 86_400_000);
    return Math.max(1, diffDays + 1);
}

/**
 * The rate for one day ('YYYY-MM-DD'): a special-date price, else the weekend
 * rate on a Saturday or Sunday, else the day rate. Mirrors server
 * utils/venuePricing.js priceForDay.
 */
export function venuePriceForDay(venue: VenueLikePricing | null | undefined, dayKey: string): number {
    const pricing = venue?.pricing;
    const special = pricing?.specialDates?.find(d => d.date === dayKey);
    if (special && special.pricePerDay > 0) return special.pricePerDay;
    const weekday = new Date(`${dayKey}T00:00:00Z`).getUTCDay();
    if ((weekday === 0 || weekday === 6) && (pricing?.weekendPricePerDay ?? 0) > 0) return pricing!.weekendPricePerDay!;
    return venueDayRate(venue);
}

/** Whether the venue charges differently on some days (weekend or special dates). */
export function hasDemandPricing(venue: VenueLikePricing | null | undefined): boolean {
    const pricing = venue?.pricing;
    return (pricing?.weekendPricePerDay ?? 0) > 0 || (pricing?.specialDates?.length ?? 0) > 0;
}

/** Every 'YYYY-MM-DD' a booking covers, start to end inclusive (as the server counts them). */
export function bookingDayKeys(startDate: string, endDate?: string | null): string[] {
    if (!startDate) return [];
    const first = Date.parse(`${startDate.slice(0, 10)}T00:00:00Z`);
    const last = endDate ? Date.parse(`${endDate.slice(0, 10)}T00:00:00Z`) : first;
    if (Number.isNaN(first) || Number.isNaN(last)) return [];
    const keys: string[] = [];
    for (let t = first; t <= last && keys.length < 31; t += 86_400_000) {
        keys.push(new Date(t).toISOString().slice(0, 10));
    }
    return keys;
}

/** What the guest owes before the platform's advance percentage is applied: each day at its own rate. */
export function venueBookingTotal(
    venue: VenueLikePricing | null | undefined,
    startDate: string,
    endDate?: string | null
): number {
    const keys = bookingDayKeys(startDate, endDate);
    if (keys.length === 0) return roundMoney(venueDayRate(venue) * billableDays(startDate, endDate));
    return roundMoney(keys.reduce((sum, key) => sum + venuePriceForDay(venue, key), 0));
}

/**
 * Share of the booking total taken as a non-refundable advance at checkout.
 * Mirrors `roundMoney(booking.totalAmount * 0.10)` in bookingService.
 */
export const BOOKING_ADVANCE_RATE = 0.1;

/** Fallback platform fee percentage, matching the server's `?? 5`. */
export const DEFAULT_PLATFORM_FEE_PERCENTAGE = 5;

/** GST rate charged on the platform fee, matching paymentService. */
const GST_ON_FEE_RATE = 0.18;

export interface AdvanceBreakdown {
    /** 10% of the booking total - the advance itself. */
    advance: number;
    /** Platform fee charged on the advance. */
    platformFee: number;
    platformFeePercentage: number;
    /** GST on the platform fee. */
    gstAmount: number;
    /** What the gateway actually charges today. */
    payableNow: number;
    /** The 90% balance, paid on Fira by 24 hours before the event. */
    remaining: number;
}

/**
 * What the guest pays at checkout for a venue booking, itemised.
 *
 * This exists because the booking modal used to show only the bare 10% advance
 * while the server routed that advance through `calculateBilling`, adding a
 * platform fee and GST on top. A ₹166 booking displayed "Required 10% Advance ₹17"
 * and Razorpay then asked for ₹18 - the gateway is the first place the guest saw
 * the real number, which is the worst possible place to learn it.
 *
 * Every line here mirrors the server:
 *   advance     = roundMoney(total × 0.10)
 *   platformFee = roundMoney(advance × feePct / 100)
 *   gst         = roundMoney(platformFee × 0.18)
 *   payableNow  = advance + platformFee + gst
 *
 * Rounding is to paise, at each step and in the same order as the server.
 * Rounding the sum instead of the parts can differ by a paise, and rounding to
 * whole rupees (what this did before) threw away the paise entirely.
 */
export function bookingAdvance(
    bookingTotal: number,
    platformFeePercentage: number = DEFAULT_PLATFORM_FEE_PERCENTAGE
): AdvanceBreakdown {
    const advance = roundMoney(bookingTotal * BOOKING_ADVANCE_RATE);
    const platformFee = roundMoney((advance * platformFeePercentage) / 100);
    const gstAmount = roundMoney(platformFee * GST_ON_FEE_RATE);

    return {
        advance,
        platformFee,
        platformFeePercentage,
        gstAmount,
        payableNow: roundMoney(advance + platformFee + gstAmount),
        remaining: roundMoney(bookingTotal - advance),
    };
}
