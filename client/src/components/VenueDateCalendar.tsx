'use client';

import { useMemo, useState } from 'react';
import { localKey } from '@/lib/venueEventAvailability';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/**
 * What a day is for the person picking dates:
 *  - free: pick it;
 *  - taken: booked or blocked, cannot be picked;
 *  - closed: the venue does not open that day, cannot be picked;
 *  - event: another event that day - pickable, the times are checked later.
 */
export type CalendarDayStatus = 'free' | 'taken' | 'closed' | 'event';

interface Props {
    venueName: string;
    loading?: boolean;
    startKey: string;
    endKey: string;
    /** Sets both dates ('YYYY-MM-DD'); a one-day pick sends the same day twice. */
    onChange: (startKey: string, endKey: string) => void;
    /** The page's own rules for a day (they differ between bookings and events). */
    dayStatus: (key: string) => CalendarDayStatus;
    /** How many months after this one can be shown. */
    monthsAhead?: number;
}

const prettyDay = (key: string) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

/**
 * A venue's month, so people pick dates the venue can actually take instead of
 * finding out after submitting. Tap a day for one day, then a later day to make
 * it a range; a range that would run over a taken or closed day is refused here.
 * Used by guest bookings and by Create Event.
 */
export default function VenueDateCalendar({
    venueName, loading = false, startKey, endKey, onChange, dayStatus, monthsAhead = 12,
}: Props) {
    const today = useMemo(() => new Date(), []);
    const todayKey = localKey(today);
    const initial = startKey ? new Date(`${startKey}T00:00:00`) : today;
    const [month, setMonth] = useState(new Date(initial.getFullYear(), initial.getMonth(), 1));
    const [pickingEnd, setPickingEnd] = useState(false);
    const [notice, setNotice] = useState('');

    const firstMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastMonth = new Date(today.getFullYear(), today.getMonth() + monthsAhead, 1);
    const canPrev = month > firstMonth;
    const canNext = month < lastMonth;

    const cells = useMemo(() => {
        const out: (string | null)[] = Array.from({ length: month.getDay() }, () => null);
        const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
        for (let d = 1; d <= days; d++) out.push(localKey(new Date(month.getFullYear(), month.getMonth(), d)));
        return out;
    }, [month]);

    const blocked = (s: CalendarDayStatus) => s === 'taken' || s === 'closed';

    /** The first day in [from, to] that cannot be booked, or null. */
    const firstBlocked = (from: string, to: string): string | null => {
        const [y, m, d] = from.split('-').map(Number);
        const cursor = new Date(y, m - 1, d);
        for (let i = 0; i < 400; i++) {
            const key = localKey(cursor);
            if (key > to) return null;
            if (blocked(dayStatus(key))) return key;
            cursor.setDate(cursor.getDate() + 1);
        }
        return null;
    };

    const pick = (key: string) => {
        setNotice('');
        if (pickingEnd && startKey && key > startKey) {
            const stop = firstBlocked(startKey, key);
            if (stop) {
                setNotice(`${venueName} isn't available on ${prettyDay(stop)}, so the dates can't run across it.`);
                return;
            }
            onChange(startKey, key);
            setPickingEnd(false);
            return;
        }
        onChange(key, key);
        setPickingEnd(true);
    };

    const rangeEnd = endKey && startKey && endKey >= startKey ? endKey : startKey;

    return (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                    <p className="text-sm font-medium text-white">When {venueName} is free</p>
                    <p className="text-xs text-gray-400">
                        {pickingEnd && startKey
                            ? `Starts ${prettyDay(startKey)}. Tap a later day for more than one day, or keep it to one.`
                            : 'Tap a day to set your dates.'}
                    </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        type="button"
                        onClick={() => canPrev && setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
                        disabled={!canPrev}
                        aria-label="Previous month"
                        className="p-1.5 rounded-lg text-gray-300 hover:bg-white/10 disabled:opacity-30"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    </button>
                    <span className="text-sm text-gray-200 w-28 text-center">
                        {month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
                    </span>
                    <button
                        type="button"
                        onClick={() => canNext && setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
                        disabled={!canNext}
                        aria-label="Next month"
                        className="p-1.5 rounded-lg text-gray-300 hover:bg-white/10 disabled:opacity-30"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                    </button>
                </div>
            </div>

            {loading ? (
                <div className="h-56 rounded-lg bg-white/[0.03] animate-pulse" aria-busy="true" />
            ) : (
                <>
                    <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-gray-500 mb-1">
                        {WEEKDAYS.map(d => <div key={d}>{d}</div>)}
                    </div>
                    <div className="grid grid-cols-7 gap-1">
                        {cells.map((key, i) => {
                            if (!key) return <div key={`blank-${i}`} />;
                            const past = key < todayKey;
                            const status = dayStatus(key);
                            const off = blocked(status);
                            const inRange = !!startKey && key >= startKey && key <= rangeEnd;
                            let cls = 'text-gray-200 hover:bg-white/10';
                            if (past) cls = 'text-gray-600 cursor-not-allowed';
                            else if (status === 'taken') cls = 'text-red-300/70 bg-red-500/10 line-through cursor-not-allowed';
                            else if (status === 'closed') cls = 'text-gray-500 bg-white/[0.04] cursor-not-allowed';
                            else if (status === 'event') cls = 'text-amber-200 bg-amber-500/10 hover:bg-amber-500/20';
                            if (inRange && !past && !off) cls = 'bg-violet-500 text-white font-semibold';
                            const label = status === 'taken' ? ', not available' : status === 'closed' ? ', closed'
                                : status === 'event' ? ', another event that day' : '';
                            return (
                                <button
                                    key={key}
                                    type="button"
                                    disabled={past || off}
                                    onClick={() => pick(key)}
                                    aria-pressed={inRange}
                                    aria-label={`${prettyDay(key)}${label}`}
                                    className={`relative h-9 rounded-lg text-sm transition-colors ${cls}`}
                                >
                                    {Number(key.slice(8))}
                                    {status === 'event' && !inRange && !past && (
                                        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-amber-400" />
                                    )}
                                </button>
                            );
                        })}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-[11px] text-gray-400">
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-white/20" />Free</span>
                        {cells.some(k => k && k >= todayKey && dayStatus(k) === 'event') && (
                            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-amber-500/40" />Another event that day (pick a time that doesn&apos;t overlap)</span>
                        )}
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-red-500/30" />Not available</span>
                        {cells.some(k => k && k >= todayKey && dayStatus(k) === 'closed') && (
                            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-white/[0.08]" />Closed</span>
                        )}
                    </div>
                </>
            )}
            {notice && <p role="alert" className="text-xs text-red-400 mt-2">{notice}</p>}
        </div>
    );
}
