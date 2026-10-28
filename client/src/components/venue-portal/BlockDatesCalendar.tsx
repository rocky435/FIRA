'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { venuesApi, clearRequestCache } from '@/lib/api';
import { localKey, type VenueEventCalendar } from '@/lib/venueEventAvailability';
import { Button } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS_AHEAD = 12;

type OwnerDay = 'free' | 'blocked' | 'booking' | 'event';

/** What a day is from the owner's side: blocked by them, held by FIRA activity, or free. */
function ownerDayStatus(cal: VenueEventCalendar | null, key: string): OwnerDay {
    if (!cal) return 'free';
    const slots = cal.blockedDates?.find(b => b.date === key)?.slots || [];
    if (slots.some(s => s.type === 'booked' && s.event)) return 'event';
    if (cal.unavailableDates?.includes(key) || slots.some(s => s.type === 'booked')) return 'booking';
    if ((cal.eventSlots || []).some(e => key >= localKey(new Date(e.start)) && key <= localKey(new Date(e.end)))) return 'event';
    if (slots.some(s => s.type === 'busy')) return 'blocked';
    return 'free';
}

const prettyDay = (key: string) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

/**
 * The owner's own calendar: tap the days you've booked outside FIRA, then
 * block them, so no guest or organiser can book them here. Days a FIRA booking
 * or event already holds are shown but can't be changed from here.
 */
export default function BlockDatesCalendar({ venueId }: { venueId: string }) {
    const { showToast } = useToast();
    const today = useMemo(() => new Date(), []);
    const todayKey = localKey(today);
    const [month, setMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
    const [calendar, setCalendar] = useState<VenueEventCalendar | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [selected, setSelected] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        setError('');
        try {
            clearRequestCache(`/venues/${venueId}`);
            setCalendar(await venuesApi.getById(venueId) as VenueEventCalendar);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load your calendar');
        } finally {
            setLoading(false);
        }
    }, [venueId]);

    useEffect(() => { load(); }, [load]);

    const firstMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastMonth = new Date(today.getFullYear(), today.getMonth() + MONTHS_AHEAD, 1);

    const cells = useMemo(() => {
        const out: (string | null)[] = Array.from({ length: month.getDay() }, () => null);
        const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
        for (let d = 1; d <= days; d++) out.push(localKey(new Date(month.getFullYear(), month.getMonth(), d)));
        return out;
    }, [month]);

    const toBlock = selected.filter(k => ownerDayStatus(calendar, k) === 'free').sort();
    const toUnblock = selected.filter(k => ownerDayStatus(calendar, k) === 'blocked').sort();

    const toggle = (key: string) =>
        setSelected(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]));

    const save = async (mode: 'block' | 'unblock') => {
        const days = mode === 'block' ? toBlock : toUnblock;
        if (!days.length) return;
        setSaving(true);
        try {
            const { blockedDates } = await venuesApi.setBlockedDays(venueId, mode === 'block' ? { block: days } : { unblock: days });
            setCalendar(prev => (prev ? { ...prev, blockedDates } : prev));
            setSelected(prev => prev.filter(k => !days.includes(k)));
            showToast(mode === 'block'
                ? `Blocked ${days.length} day${days.length > 1 ? 's' : ''}. Guests can't book ${days.length > 1 ? 'them' : 'it'} now.`
                : `Unblocked ${days.length} day${days.length > 1 ? 's' : ''}. Open for bookings again.`, 'success');
        } catch (err) {
            showToast(err instanceof Error ? err.message : 'Could not save your changes', 'error');
            // Someone may have booked one of these meanwhile; show the current state.
            load();
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="bg-white/[0.02] border border-white/[0.08] rounded-2xl p-5 sm:p-6">
            <h2 className="text-xl font-semibold text-white mb-1">Block dates</h2>
            <p className="text-gray-300 text-sm mb-4">
                Got a booking outside FIRA? Tap those days and block them, so nobody can book them here.
            </p>

            <div className="flex items-center justify-between mb-3">
                <button
                    type="button"
                    onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
                    disabled={month <= firstMonth}
                    aria-label="Previous month"
                    className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 disabled:opacity-30"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                </button>
                <span className="text-white font-medium">{month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</span>
                <button
                    type="button"
                    onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
                    disabled={month >= lastMonth}
                    aria-label="Next month"
                    className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 disabled:opacity-30"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </button>
            </div>

            {loading ? (
                <div className="h-64 rounded-xl bg-white/[0.03] animate-pulse" aria-busy="true" />
            ) : error ? (
                <div className="py-8 text-center">
                    <p className="text-red-400 text-sm mb-3">{error}</p>
                    <Button size="sm" variant="secondary" onClick={() => { setLoading(true); load(); }}>Try again</Button>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-7 gap-1 mb-1 text-center text-xs text-gray-400">
                        {WEEKDAYS.map(d => <div key={d}>{d}</div>)}
                    </div>
                    <div className="grid grid-cols-7 gap-1">
                        {cells.map((key, i) => {
                            if (!key) return <div key={`blank-${i}`} />;
                            const past = key < todayKey;
                            const status = ownerDayStatus(calendar, key);
                            const locked = past || status === 'booking' || status === 'event';
                            const isSelected = selected.includes(key);
                            let cls = 'text-gray-200 hover:bg-white/10';
                            if (past) cls = 'text-gray-600';
                            else if (status === 'booking') cls = 'bg-green-500/15 text-green-300';
                            else if (status === 'event') cls = 'bg-sky-500/15 text-sky-300';
                            else if (status === 'blocked') cls = 'bg-red-500/25 text-red-200 line-through hover:bg-red-500/35';
                            if (isSelected) cls += ' ring-2 ring-violet-400';
                            return (
                                <button
                                    key={key}
                                    type="button"
                                    disabled={locked || saving}
                                    onClick={() => toggle(key)}
                                    aria-pressed={isSelected}
                                    aria-label={`${prettyDay(key)}: ${status === 'blocked' ? 'blocked by you' : status === 'booking' ? 'booked on FIRA' : status === 'event' ? 'event on FIRA' : 'free'}`}
                                    title={status === 'booking' ? 'Booked or requested on FIRA - answer it from Bookings' : status === 'event' ? 'An event is on this day' : undefined}
                                    className={`aspect-square sm:aspect-auto sm:h-10 rounded-lg text-sm font-medium transition-colors disabled:cursor-not-allowed ${cls}`}
                                >
                                    {Number(key.slice(8))}
                                </button>
                            );
                        })}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-gray-400">
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-red-500/40" />Blocked by you</span>
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-green-500/30" />Booking on FIRA</span>
                        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-sky-500/30" />Event on FIRA</span>
                    </div>

                    {selected.length > 0 && (
                        <div className="mt-4 p-4 rounded-xl bg-violet-500/10 border border-violet-500/30 flex flex-col sm:flex-row sm:items-center gap-3">
                            <p className="text-sm text-violet-200 flex-1">
                                {selected.length} day{selected.length > 1 ? 's' : ''} selected
                            </p>
                            <div className="flex flex-wrap gap-2">
                                <Button size="sm" variant="ghost" onClick={() => setSelected([])} disabled={saving}>Clear</Button>
                                {toUnblock.length > 0 && (
                                    <Button size="sm" variant="secondary" onClick={() => save('unblock')} disabled={saving}>
                                        Unblock {toUnblock.length}
                                    </Button>
                                )}
                                {toBlock.length > 0 && (
                                    <Button size="sm" onClick={() => save('block')} disabled={saving}>
                                        {saving ? 'Saving…' : `Block ${toBlock.length} day${toBlock.length > 1 ? 's' : ''}`}
                                    </Button>
                                )}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
