// @ts-check

const { roundMoney } = require('./money');

const INSTALLMENT_THRESHOLD_HOURS = 168; // 7 days: nearer than this ⇒ full payment at booking
const BALANCE_DUE_HOURS_BEFORE = 24;     // the 90% balance is due 24h before the event starts
const REMINDER_WINDOW_HOURS = 168;       // balance reminders start 7 days before the event
const DEPOSIT_RATE = 0.10;
const RESPONSE_WINDOW_HOURS = 48;        // the owner answers a request, and the guest then pays, within this
const MS_PER_HOUR = 3600 * 1000;

/**
 * Combine bookingDate + "HH:MM" startTime into one Date, matching the exact
 * convention in venueService.processCancellation (Req 10.1):
 *   const bookingDate = new Date(booking.bookingDate);
 *   const [hours, minutes] = booking.startTime.split(':').map(Number);
 *   bookingDate.setHours(hours, minutes, 0, 0);
 *
 * @param {Date | string | number} bookingDate
 * @param {string} startTime  "HH:MM"
 * @returns {Date}
 */
function eventStartAt(bookingDate, startTime) {
    const d = new Date(bookingDate);
    const [h, m] = String(startTime).split(':').map(Number);
    d.setHours(h, m, 0, 0);
    return d;
}

/**
 * Hours between `now` and event start (Req 1.1).
 *
 * @param {Date} now
 * @param {Date | string | number} bookingDate
 * @param {string} startTime
 * @returns {number}
 */
function hoursUntilEvent(now, bookingDate, startTime) {
    return (eventStartAt(bookingDate, startTime).getTime() - now.getTime()) / MS_PER_HOUR;
}

/**
 * The frozen payment schedule for a booking, decided once at booking creation
 * (Req 10.3). Hours_Until_Event > 168 ⇒ installment; ≤ 168 ⇒ full. Exactly 168
 * hours is treated as "not farther than 7 days" ⇒ full (Req 10.2).
 *
 * An installment's balance is due 24h before the event, not 7 days: the guest
 * holds the date with 10%, is reminded daily from 7 days out, and loses the
 * booking (and the deposit) only if the balance is still unpaid the day before.
 *
 * balanceAmount is the remainder (total − deposit), not an independent total×0.90,
 * so depositAmount + balanceAmount === totalAmount exactly under paise rounding
 * (Property 1).
 *
 * @param {Date} now
 * @param {Date | string | number} bookingDate
 * @param {string} startTime
 * @param {number} totalAmount
 * @returns {{
 *   type: 'installment' | 'full',
 *   depositAmount: number,
 *   balanceAmount: number,
 *   balanceDueAt: Date | null,
 *   balanceStatus: 'pending' | 'not_applicable'
 * }}
 */
function build(now, bookingDate, startTime, totalAmount) {
    const hrs = hoursUntilEvent(now, bookingDate, startTime);
    if (hrs > INSTALLMENT_THRESHOLD_HOURS) {
        const deposit = roundMoney(totalAmount * DEPOSIT_RATE);
        return {
            type: 'installment',
            depositAmount: deposit,
            balanceAmount: roundMoney(totalAmount - deposit), // remainder ⇒ deposit+balance===total (Property 1)
            balanceDueAt: new Date(
                eventStartAt(bookingDate, startTime).getTime() - BALANCE_DUE_HOURS_BEFORE * MS_PER_HOUR
            ), // Property 3: exactly 24h before event start
            balanceStatus: 'pending',
        };
    }
    return fullSchedule(totalAmount);
}

/**
 * The schedule when the whole amount is paid at once - always an option for the
 * guest, and the only one 7 days or less before the booking.
 *
 * @param {number} totalAmount
 * @returns {{ type: 'full', depositAmount: number, balanceAmount: number, balanceDueAt: null, balanceStatus: 'not_applicable' }}
 */
function fullSchedule(totalAmount) {
    return {
        type: 'full',
        depositAmount: roundMoney(totalAmount),
        balanceAmount: 0,
        balanceDueAt: null,
        balanceStatus: 'not_applicable',
    };
}

/**
 * When a step that starts at `from` must be done by: the owner answering a
 * request, or the guest paying once it is accepted. RESPONSE_WINDOW_HOURS later,
 * but never later than 24 hours before the booking starts. A step that starts
 * inside that last day (a last-minute booking) has until the booking starts.
 *
 * @param {Date | string | number} from
 * @param {Date | string | number} bookingDate
 * @param {string} startTime "HH:MM"
 * @returns {Date}
 */
function stepDeadline(from, bookingDate, startTime) {
    const start = eventStartAt(bookingDate, startTime).getTime();
    const cutoff = start - BALANCE_DUE_HOURS_BEFORE * MS_PER_HOUR;
    const f = new Date(from).getTime();
    if (cutoff - f < 2 * MS_PER_HOUR) return new Date(Math.max(start, f));
    return new Date(Math.min(f + RESPONSE_WINDOW_HOURS * MS_PER_HOUR, cutoff));
}

module.exports = {
    build,
    fullSchedule,
    stepDeadline,
    hoursUntilEvent,
    eventStartAt,
    INSTALLMENT_THRESHOLD_HOURS,
    BALANCE_DUE_HOURS_BEFORE,
    REMINDER_WINDOW_HOURS,
    DEPOSIT_RATE,
    RESPONSE_WINDOW_HOURS,
};
