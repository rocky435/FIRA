// Shared date/time formatting utilities

function getOrdinal(n: number): string {
    const s = ["th", "st", "nd", "rd"], v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
}

function monthName(date: Date): string {
    return date.toLocaleString("en-US", { month: "long" });
}

function monthShort(date: Date): string {
    return date.toLocaleString("en-US", { month: "short" });
}

function parseDate(dateStr: string): Date {
    return new Date(dateStr);
}

function formatTime(date: Date): string {
    const hours = date.getHours().toString().padStart(2, '0');
    const mins = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${mins}`;
}

// Format DateTime as "30th Dec 14:00" for event cards
export function formatEventDateTime(dateTimeStr: string): string {
    const date = parseDate(dateTimeStr);
    if (isNaN(date.getTime())) return 'Invalid Date';
    const day = date.getDate();
    return `${day}${getOrdinal(day)} ${monthShort(date)} ${formatTime(date)}`;
}

// Format DateTime range: "from 30th December 14:00 to 31st December 18:00"
export function formatDateTimeRange(startDateTimeStr: string, endDateTimeStr: string): string {
    const startDate = parseDate(startDateTimeStr);
    const endDate = parseDate(endDateTimeStr);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return 'Invalid Date Range';
    }

    const startDay = startDate.getDate();
    const endDay = endDate.getDate();

    const startPart = `${startDay}${getOrdinal(startDay)} ${monthName(startDate)} ${formatTime(startDate)}`;
    const endPart = `${endDay}${getOrdinal(endDay)} ${monthName(endDate)} ${formatTime(endDate)}`;

    return `from ${startPart} to ${endPart}`;
}

/**
 * A booking's dates: "12 Nov 2026" for one day, "12 – 13 Nov 2026" or
 * "30 Oct – 3 Nov 2026" for a range. `endDate` is null/absent (or the same day)
 * for a single-day booking.
 */
export function formatBookingDates(bookingDate: string, endDate?: string | null): string {
    const start = parseDate(bookingDate);
    if (isNaN(start.getTime())) return 'Invalid Date';
    const full = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const end = endDate ? parseDate(endDate) : null;
    if (!end || isNaN(end.getTime()) || end.toDateString() === start.toDateString()) return full(start);

    const sameYear = start.getFullYear() === end.getFullYear();
    const sameMonth = sameYear && start.getMonth() === end.getMonth();
    const startPart = sameMonth
        ? String(start.getDate())
        : start.toLocaleDateString('en-IN', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
    return `${startPart} – ${full(end)}`;
}

// Format single DateTime: "30th December 14:00"
export function formatSingleDateTime(dateTimeStr: string): string {
    const date = parseDate(dateTimeStr);
    if (isNaN(date.getTime())) return 'Invalid Date';
    const day = date.getDate();
    return `${day}${getOrdinal(day)} ${monthName(date)} ${formatTime(date)}`;
}

// Legacy support - kept for backward compatibility with old data
export function formatEventCardDateTime(dateStr: string, time?: string): string {
    const date = parseDate(dateStr);
    if (isNaN(date.getTime())) return 'Invalid Date';
    const day = date.getDate();
    const timeStr = time || formatTime(date);
    return `${day}${getOrdinal(day)} ${monthShort(date)} ${timeStr}`;
}

export function formatHumanDate(dateStr: string): string {
    const d = parseDate(dateStr);
    if (isNaN(d.getTime())) return 'Invalid Date';
    const day = d.getDate();
    return `${day}${getOrdinal(day)} ${monthName(d)}`;
}

