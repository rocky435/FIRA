/**
 * Which days a listed venue can host a new event on, mirroring the checks
 * eventService.createEvent makes on the server:
 *  - a day the owner blocked as busy, or one a guest's booking holds, is taken;
 *  - another event at the venue only clashes where the times overlap, so its
 *    days are shown as "has an event" rather than taken.
 *
 * The server stays the authority - this is what lets the Create Event form say
 * so on the date step instead of on the last one.
 */

export interface VenueEventCalendar {
    blockedDates?: { date: string; slots?: { type?: string; event?: string | null }[] }[];
    /** Days held by a pending or accepted personal booking ('YYYY-MM-DD'). */
    unavailableDates?: string[];
    /** When upcoming events at the venue run (ISO date-times). */
    eventSlots?: { _id: string; start: string; end: string }[];
}

export type VenueDayStatus = 'free' | 'taken' | 'event';

/** 'YYYY-MM-DD' for a Date, in the viewer's own time zone (what the date inputs use). */
export function localKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function otherEvents(cal: VenueEventCalendar | null | undefined, excludeEventId?: string) {
    return (cal?.eventSlots || []).filter(e => e._id !== excludeEventId);
}

export function venueDayStatus(
    cal: VenueEventCalendar | null | undefined,
    key: string,
    excludeEventId?: string,
): VenueDayStatus {
    if (!cal) return 'free';
    if (cal.unavailableDates?.includes(key)) return 'taken';
    const entry = cal.blockedDates?.find(b => b.date === key);
    const slots = entry?.slots || [];
    // Owner busy blocks, and booked days that are not an event (an accepted
    // personal booking), take the whole day.
    if (slots.some(s => s.type === 'busy' || (s.type === 'booked' && !s.event))) return 'taken';
    if (slots.some(s => s.type === 'booked' && s.event && s.event !== excludeEventId)) return 'event';
    const hasEvent = otherEvents(cal, excludeEventId).some(e => {
        const first = localKey(new Date(e.start));
        const last = localKey(new Date(e.end));
        return key >= first && key <= last;
    });
    return hasEvent ? 'event' : 'free';
}

/** The first taken day in [startKey, endKey], or null when the venue is free throughout. */
export function firstTakenDay(
    cal: VenueEventCalendar | null | undefined,
    startKey: string,
    endKey: string | null | undefined,
    excludeEventId?: string,
): string | null {
    if (!cal || !startKey) return null;
    const last = endKey && endKey >= startKey ? endKey : startKey;
    const [y, m, d] = startKey.split('-').map(Number);
    const cursor = new Date(y, m - 1, d);
    for (let i = 0; i < 400; i++) {
        const key = localKey(cursor);
        if (key > last) break;
        if (venueDayStatus(cal, key, excludeEventId) === 'taken') return key;
        cursor.setDate(cursor.getDate() + 1);
    }
    return null;
}

/** Another event at the venue whose time overlaps [start, end), or null. Same rule as the server. */
export function clashingEvent(
    cal: VenueEventCalendar | null | undefined,
    start: Date,
    end: Date,
    excludeEventId?: string,
): { start: string; end: string } | null {
    if (!cal || isNaN(start.getTime()) || isNaN(end.getTime())) return null;
    return otherEvents(cal, excludeEventId).find(e =>
        new Date(e.start).getTime() < end.getTime() && new Date(e.end).getTime() > start.getTime(),
    ) || null;
}
