import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import adminApi from '../api/adminApi';
import { FadeIn } from '../components/animations';
import { Button } from '../components/ui/Button';
import { Pagination } from '../components/ui/Pagination';
import { formatInr } from '../lib/formatInr';

const STATUSES = ['all', 'pending', 'accepted', 'completed', 'rejected', 'cancelled'];
const STATUS_LABEL = { all: 'All', pending: 'Awaiting owner', accepted: 'Accepted', completed: 'Completed', rejected: 'Rejected', cancelled: 'Cancelled' };
const STATUS_STYLE = {
    pending: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/25',
    accepted: 'bg-green-500/15 text-green-300 border-green-500/25',
    completed: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
    rejected: 'bg-red-500/15 text-red-300 border-red-500/25',
    cancelled: 'bg-gray-500/15 text-gray-300 border-gray-500/25',
};
const PAYMENTS = [
    { value: 'all', label: 'Any payment' },
    { value: 'paid', label: 'Paid' },
    { value: 'pending', label: 'Not paid yet' },
    { value: 'refunded', label: 'Refunded' },
    { value: 'failed', label: 'Payment failed' },
];

const day = (d, opts) => new Date(d).toLocaleDateString('en-IN', opts);
const FULL = { day: 'numeric', month: 'short', year: 'numeric' };

/**
 * "12 Nov 2026", "12 – 13 Nov 2026", "30 Oct – 3 Nov 2026". Mirrors
 * formatBookingDates in client/src/lib/dateUtils.ts so both apps show a
 * booking's dates the same way.
 */
function bookingDates(start, end) {
    const a = new Date(start);
    if (!start || Number.isNaN(a.getTime())) return '—';
    const b = end ? new Date(end) : null;
    if (!b || Number.isNaN(b.getTime()) || a.toDateString() === b.toDateString()) return day(a, FULL);
    if (a.getFullYear() !== b.getFullYear()) return `${day(a, FULL)} – ${day(b, FULL)}`;
    if (a.getMonth() !== b.getMonth()) return `${day(a, { day: 'numeric', month: 'short' })} – ${day(b, FULL)}`;
    return `${a.getDate()} – ${day(b, FULL)}`;
}

/** What the guest has paid, in words an admin can act on. */
function paymentSummary(b) {
    const s = b.paymentSchedule || {};
    if (b.paymentStatus === 'refunded') return { main: 'Refunded', tone: 'text-gray-400' };
    if (b.paymentStatus === 'failed') return { main: 'Payment failed', tone: 'text-red-300' };
    if (b.paymentStatus !== 'paid') {
        return {
            main: 'Not paid yet',
            sub: b.status === 'accepted' ? 'Guest has 48h to pay after acceptance' : null,
            tone: 'text-gray-400',
        };
    }
    if (s.type === 'installment' && s.balanceStatus === 'pending') {
        return {
            main: `${formatInr(b.received)} of ${formatInr(b.totalAmount)}`,
            sub: `Advance paid · rest due ${s.balanceDueAt ? day(s.balanceDueAt, { day: 'numeric', month: 'short' }) : 'before the event'}`,
            tone: 'text-amber-200',
        };
    }
    if (s.type === 'installment' && s.balanceStatus === 'forfeited') {
        return { main: `${formatInr(b.received)} of ${formatInr(b.totalAmount)}`, sub: 'Rest was never paid', tone: 'text-red-300' };
    }
    return { main: `${formatInr(b.received)} paid`, sub: 'Paid in full', tone: 'text-green-300' };
}

/**
 * Every booking across every venue, newest first, so an admin can see what is
 * booked and what guests have paid without opening venues one by one.
 * `?venue=<id>` narrows it to one venue (linked from the venue's page).
 */
export default function Bookings() {
    const navigate = useNavigate();
    const [params, setParams] = useSearchParams();
    const venueFilter = params.get('venue') || '';
    const [status, setStatus] = useState('all');
    const [payment, setPayment] = useState('all');
    const [search, setSearch] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const [page, setPage] = useState(1);
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const query = { page, limit: 20 };
            if (status !== 'all') query.status = status;
            if (payment !== 'all') query.paymentStatus = payment;
            if (search) query.search = search;
            if (venueFilter) query.venue = venueFilter;
            setData(await adminApi.getBookings(query));
        } catch (err) {
            setError(err.message || 'Failed to load bookings');
            setData(null);
        } finally {
            setLoading(false);
        }
    }, [page, status, payment, search, venueFilter]);

    useEffect(() => { load(); }, [load]);

    const bookings = data?.bookings || [];
    const counts = data?.counts || {};
    const allCount = Object.values(counts).reduce((a, n) => a + n, 0);
    const venueName = venueFilter && bookings[0]?.venue?.name;

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <FadeIn>
                <div className="mb-8">
                    <h1 className="text-3xl font-bold text-white mb-2">Venue Bookings</h1>
                    <p className="text-gray-300">
                        Every booking request across all venues, and what each guest has paid.
                        {' '}<Link to="/payouts" className="text-violet-400 hover:text-violet-300">See who to pay</Link>
                    </p>
                </div>

                {venueFilter && (
                    <div className="flex items-center gap-3 mb-4 text-sm">
                        <span className="text-gray-300">
                            Showing only <span className="text-white font-medium">{venueName || 'one venue'}</span>
                        </span>
                        <button
                            type="button"
                            onClick={() => { params.delete('venue'); setParams(params); setPage(1); }}
                            className="text-violet-400 hover:text-violet-300"
                        >
                            Show all venues
                        </button>
                    </div>
                )}

                <div className="flex flex-col gap-3 mb-6">
                    <div className="flex gap-2 overflow-x-auto pb-1">
                        {STATUSES.map(s => {
                            const n = s === 'all' ? allCount : (counts[s] || 0);
                            return (
                                <button
                                    key={s}
                                    type="button"
                                    onClick={() => { setStatus(s); setPage(1); }}
                                    className={`px-4 py-2 rounded-xl text-sm font-medium transition-all whitespace-nowrap ${status === s
                                        ? 'bg-white text-black shadow-lg shadow-white/10'
                                        : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white'}`}
                                >
                                    {STATUS_LABEL[s]} <span className="text-gray-500">{n}</span>
                                </button>
                            );
                        })}
                    </div>
                    <div className="flex flex-col md:flex-row gap-3">
                        <select
                            value={payment}
                            onChange={e => { setPayment(e.target.value); setPage(1); }}
                            aria-label="Payment"
                            className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-white text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50"
                        >
                            {PAYMENTS.map(p => <option key={p.value} value={p.value} className="bg-gray-900">{p.label}</option>)}
                        </select>
                        <form
                            onSubmit={e => { e.preventDefault(); setSearch(searchInput.trim()); setPage(1); }}
                            className="flex gap-2 max-w-md w-full"
                        >
                            <input
                                type="text"
                                placeholder="Venue, guest name or email"
                                value={searchInput}
                                onChange={e => setSearchInput(e.target.value)}
                                className="flex-1 min-w-0 px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
                            />
                            <Button type="submit" size="sm" variant="secondary">Search</Button>
                            {search && (
                                <Button type="button" size="sm" variant="ghost" onClick={() => { setSearch(''); setSearchInput(''); setPage(1); }}>
                                    Clear
                                </Button>
                            )}
                        </form>
                    </div>
                </div>

                {error && <p role="alert" className="text-red-400 text-sm mb-4">{error}</p>}

                <div className="bg-white/[0.02] backdrop-blur-sm border border-white/[0.08] rounded-2xl overflow-hidden">
                    {loading && !data ? (
                        <div className="p-12 text-center text-gray-300">Loading bookings…</div>
                    ) : bookings.length === 0 ? (
                        <div className="p-12 text-center text-gray-300">
                            {search || status !== 'all' || payment !== 'all' ? 'No bookings match these filters.' : 'No venue bookings yet.'}
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-left min-w-[900px]">
                                <thead className="bg-white/[0.02] border-b border-white/[0.05]">
                                    <tr className="text-xs font-semibold text-gray-300">
                                        <th className="px-5 py-4">Venue</th>
                                        <th className="px-5 py-4">Guest</th>
                                        <th className="px-5 py-4">Dates</th>
                                        <th className="px-5 py-4">Status</th>
                                        <th className="px-5 py-4">Paid by guest</th>
                                        <th className="px-5 py-4">Requested</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/[0.05]">
                                    {bookings.map(b => {
                                        const pay = paymentSummary(b);
                                        const venueId = b.venue?._id;
                                        return (
                                            <tr
                                                key={b._id}
                                                onClick={() => venueId && navigate(`/venues/${venueId}`)}
                                                className={`hover:bg-white/[0.02] ${venueId ? 'cursor-pointer' : ''}`}
                                            >
                                                <td className="px-5 py-4 align-top">
                                                    <div className="text-white font-medium text-sm">{b.venue?.name || 'Deleted venue'}</div>
                                                    <div className="text-xs text-gray-500">
                                                        {[b.venue?.address?.city, b.venue?.owner?.name && `Owner: ${b.venue.owner.name}`].filter(Boolean).join(' · ')}
                                                    </div>
                                                </td>
                                                <td className="px-5 py-4 align-top">
                                                    <div className="text-gray-200 text-sm">{b.user?.name || 'Deleted account'}</div>
                                                    <div className="text-xs text-gray-500 break-all">{b.user?.email}</div>
                                                    {b.user?.phone && <div className="text-xs text-gray-500">{b.user.phone}</div>}
                                                </td>
                                                <td className="px-5 py-4 align-top text-sm">
                                                    <div className="text-gray-200 whitespace-nowrap">{bookingDates(b.bookingDate, b.endDate)}</div>
                                                    <div className="text-xs text-gray-500">
                                                        {b.startTime} – {b.endTime}{b.expectedGuests ? ` · ${b.expectedGuests} guests` : ''}
                                                    </div>
                                                </td>
                                                <td className="px-5 py-4 align-top">
                                                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap ${STATUS_STYLE[b.status] || STATUS_STYLE.cancelled}`}>
                                                        {STATUS_LABEL[b.status] || b.status}
                                                    </span>
                                                </td>
                                                <td className="px-5 py-4 align-top text-sm">
                                                    <div className={`tabular-nums ${pay.tone}`}>{pay.main}</div>
                                                    {pay.sub && <div className="text-xs text-gray-500">{pay.sub}</div>}
                                                    {b.paymentStatus !== 'paid' && (
                                                        <div className="text-xs text-gray-500 tabular-nums">Price {formatInr(b.totalAmount)}</div>
                                                    )}
                                                </td>
                                                <td className="px-5 py-4 align-top text-sm text-gray-400 whitespace-nowrap">
                                                    {new Date(b.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <Pagination currentPage={data?.currentPage || 1} totalPages={data?.totalPages || 0} onChange={setPage} />
                </div>
            </FadeIn>
        </div>
    );
}
