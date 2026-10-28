import { describe, it, expect } from 'vitest';
import { formatBookingDates } from './dateUtils';

describe('formatBookingDates', () => {
    it('shows one date for a single-day booking', () => {
        expect(formatBookingDates('2026-11-12T00:00:00.000Z')).toBe('12 Nov 2026');
        expect(formatBookingDates('2026-11-12T00:00:00.000Z', null)).toBe('12 Nov 2026');
        expect(formatBookingDates('2026-11-12T00:00:00.000Z', '2026-11-12T00:00:00.000Z')).toBe('12 Nov 2026');
    });

    it('shows the range for a multi-day booking', () => {
        expect(formatBookingDates('2026-11-12T00:00:00.000Z', '2026-11-13T00:00:00.000Z')).toBe('12 – 13 Nov 2026');
        expect(formatBookingDates('2026-10-30T00:00:00.000Z', '2026-11-03T00:00:00.000Z')).toBe('30 Oct – 3 Nov 2026');
        expect(formatBookingDates('2026-12-30T00:00:00.000Z', '2027-01-02T00:00:00.000Z')).toBe('30 Dec 2026 – 2 Jan 2027');
    });
});
