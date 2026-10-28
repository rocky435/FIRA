import { describe, it, expect } from 'vitest';
import { venueDayStatus, firstTakenDay, clashingEvent, type VenueEventCalendar } from './venueEventAvailability';

// Event times are built in local time so the day keys hold in any time zone.
const at = (key: string, hhmm: string) => new Date(`${key}T${hhmm}:00`).toISOString();

const cal: VenueEventCalendar = {
    unavailableDates: ['2026-11-12'],
    blockedDates: [
        { date: '2026-11-14', slots: [{ type: 'busy' }] },
        { date: '2026-11-15', slots: [{ type: 'booked', event: 'approved-1' }] },
        { date: '2026-11-16', slots: [{ type: 'booked' }] },
    ],
    eventSlots: [{ _id: 'pending-1', start: at('2026-11-20', '18:00'), end: at('2026-11-20', '22:00') }],
};

describe('venueDayStatus', () => {
    it('takes days held by a booking or blocked by the owner', () => {
        expect(venueDayStatus(cal, '2026-11-12')).toBe('taken');
        expect(venueDayStatus(cal, '2026-11-14')).toBe('taken');
        expect(venueDayStatus(cal, '2026-11-16')).toBe('taken');
    });

    it('marks days with another event (approved or pending) without taking them', () => {
        expect(venueDayStatus(cal, '2026-11-15')).toBe('event');
        expect(venueDayStatus(cal, '2026-11-20')).toBe('event');
        expect(venueDayStatus(cal, '2026-11-13')).toBe('free');
    });

    it("ignores the event being edited, so it does not clash with itself", () => {
        expect(venueDayStatus(cal, '2026-11-15', 'approved-1')).toBe('free');
        expect(venueDayStatus(cal, '2026-11-20', 'pending-1')).toBe('free');
    });

    it('treats a venue with no calendar loaded as free', () => {
        expect(venueDayStatus(null, '2026-11-12')).toBe('free');
    });
});

describe('firstTakenDay', () => {
    it('finds a taken day anywhere in the range, not just the start', () => {
        expect(firstTakenDay(cal, '2026-11-10', '2026-11-13')).toBe('2026-11-12');
        expect(firstTakenDay(cal, '2026-11-17', '2026-11-25')).toBeNull();
        expect(firstTakenDay(cal, '2026-11-13', null)).toBeNull();
    });

    it('crosses a month end', () => {
        const c = { unavailableDates: ['2026-12-01'] };
        expect(firstTakenDay(c, '2026-11-29', '2026-12-02')).toBe('2026-12-01');
    });
});

describe('clashingEvent', () => {
    it('clashes only where the times overlap', () => {
        const day = '2026-11-20';
        expect(clashingEvent(cal, new Date(`${day}T20:00:00`), new Date(`${day}T23:00:00`))).not.toBeNull();
        expect(clashingEvent(cal, new Date(`${day}T10:00:00`), new Date(`${day}T18:00:00`))).toBeNull();
        expect(clashingEvent(cal, new Date(`${day}T20:00:00`), new Date(`${day}T23:00:00`), 'pending-1')).toBeNull();
    });
});
