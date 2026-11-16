import { useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarDays } from 'lucide-react';
import adminApi from '../api/adminApi';
import { formatInr } from '../lib/formatInr';
import { useListParams } from '../lib/useListParams';
import { useRemote } from '../lib/useRemote';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { FilterTabs } from '../components/ui/FilterTabs';
import { SearchInput } from '../components/ui/SearchInput';
import { Select } from '../components/ui/Select';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Table, THead, Th, TBody, Td } from '../components/ui/Table';
import { Pagination } from '../components/ui/Pagination';
import { EmptyState, ErrorState, TableSkeleton } from '../components/ui/States';

// Same strip as Events: what is coming up and what is on now, the rest under
// "Others". Upcoming / ongoing / completed follow the booking's days on the
// server (an accepted booking is "upcoming" until its first day).
const MAIN_STATUSES = ['all', 'upcoming', 'ongoing'];
const OTHER_STATUSES = ['pending', 'completed', 'rejected', 'cancelled'];
const STATUSES = [...MAIN_STATUSES, ...OTHER_STATUSES];
const STATUS_LABEL = {
    all: 'All', upcoming: 'Upcoming', ongoing: 'Ongoing', pending: 'Awaiting owner',
    accepted: 'Accepted', completed: 'Completed', rejected: 'Rejected', cancelled: 'Cancelled',
};
// Booking-specific shading: "completed" is history (blue), not a success state.
const STATUS_TONE = { pending: 'warning', upcoming: 'success', ongoing: 'accent', accepted: 'success', completed: 'info', rejected: 'danger', cancelled: 'neutral' };

// Midnight UTC of today's local date: bookingDate / endDate are stored that way.
const todayKey = () => {
    const d = new Date();
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
};

/** The row's badge: an accepted booking is labelled from its days, as the tabs group it. */
function shownStatus(b, today = todayKey()) {
    if (b.status !== 'accepted') return b.status;
    const first = new Date(b.bookingDate).getTime();
    const last = new Date(b.endDate || b.bookingDate).getTime();
    if (last < today) return 'completed';
    if (first <= today) return 'ongoing';
    return 'upcoming';
}
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
    // Status, payment and search join `venue` in the URL, so Back and refresh
    // keep the view (only `venue` used to survive).
    const { params, set } = useListParams({ venue: '', status: 'all', payment: 'all', q: '', page: 1 });
    const status = STATUSES.includes(params.status) ? params.status : 'all';
    const payment = PAYMENTS.some((p) => p.value === params.payment) ? params.payment : 'all';

    const load = useCallback(() => {
        const query = { page: params.page, limit: 20 };
        if (status !== 'all') query.status = status;
        if (payment !== 'all') query.paymentStatus = payment;
        if (params.q) query.search = params.q;
        if (params.venue) query.venue = params.venue;
        return adminApi.getBookings(query);
    }, [params.page, params.q, params.venue, status, payment]);
    const { data, loading, refreshing, error, reload } = useRemote(load);

    const bookings = data?.bookings || [];
    const counts = data?.counts || {};
    const venueName = params.venue && bookings[0]?.venue?.name;
    const filtered = params.q || status !== 'all' || payment !== 'all';

    const tab = (s) => ({ value: s, label: STATUS_LABEL[s], count: counts[s] || 0 });

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader
                title="Venue Bookings"
                description={(
                    <>
                        Every booking request across all venues, and what each guest has paid.{' '}
                        <Link to="/payouts/venue-owners" className="text-violet-300 hover:text-violet-200">See who to pay</Link>
                    </>
                )}
            />

            {params.venue && (
                <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5 text-sm">
                    <span className="text-gray-300">
                        Showing only <span className="font-medium text-white">{venueName || 'one venue'}</span>
                    </span>
                    <button type="button" onClick={() => set({ venue: '' })} className="text-violet-300 hover:text-violet-200">
                        Show all venues
                    </button>
                </div>
            )}

            <div className="mb-4 flex flex-col gap-3">
                <FilterTabs label="Booking status" options={MAIN_STATUSES.map(tab)} more={OTHER_STATUSES.map(tab)} value={status} onChange={(v) => set({ status: v })} />
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className="sm:w-48">
                        <Select aria-label="Payment" value={payment} onChange={(e) => set({ payment: e.target.value })} options={PAYMENTS} />
                    </div>
                    <SearchInput value={params.q} onSearch={(q) => set({ q })} placeholder="Venue, guest name or email" label="Search bookings" />
                </div>
            </div>

            <Card padded={false} aria-busy={loading || refreshing || undefined} className={`overflow-hidden transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
                {error ? (
                    <ErrorState title="Couldn't load bookings" message={error} onRetry={reload} />
                ) : loading ? (
                    <TableSkeleton rows={6} columns={6} />
                ) : bookings.length === 0 ? (
                    <EmptyState
                        icon={CalendarDays}
                        title={filtered ? 'No bookings match these filters' : 'No venue bookings yet'}
                        message={params.q ? `Nothing found for "${params.q}".` : undefined}
                    />
                ) : (
                    <Table label="Venue bookings" className="min-w-[900px]">
                        <THead>
                            <Th>Venue</Th>
                            <Th>Guest</Th>
                            <Th>Dates</Th>
                            <Th>Status</Th>
                            <Th>Paid by guest</Th>
                            <Th>Requested</Th>
                        </THead>
                        <TBody>
                            {bookings.map((b) => {
                                const pay = paymentSummary(b);
                                const shown = shownStatus(b);
                                const venueId = b.venue?._id;
                                return (
                                    <tr
                                        key={b._id}
                                        onClick={() => venueId && navigate(`/venues/${venueId}`)}
                                        className={venueId ? 'cursor-pointer' : ''}
                                    >
                                        <Td className="align-top">
                                            <div className="text-sm font-medium text-white">{b.venue?.name || 'Deleted venue'}</div>
                                            <div className="text-xs text-gray-500">
                                                {[b.venue?.address?.city, b.venue?.owner?.name && `Owner: ${b.venue.owner.name}`].filter(Boolean).join(' · ')}
                                            </div>
                                        </Td>
                                        <Td className="align-top">
                                            <div className="text-sm text-gray-200">{b.user?.name || 'Deleted account'}</div>
                                            <div className="break-all text-xs text-gray-500">{b.user?.email}</div>
                                            {b.user?.phone && <div className="text-xs text-gray-500">{b.user.phone}</div>}
                                        </Td>
                                        <Td className="align-top">
                                            <div className="whitespace-nowrap text-gray-200">{bookingDates(b.bookingDate, b.endDate)}</div>
                                            <div className="text-xs text-gray-500">
                                                {b.startTime} – {b.endTime}{b.expectedGuests ? ` · ${b.expectedGuests} guests` : ''}
                                            </div>
                                        </Td>
                                        <Td className="align-top">
                                            <StatusBadge tone={STATUS_TONE[shown] || 'neutral'}>{STATUS_LABEL[shown] || shown}</StatusBadge>
                                        </Td>
                                        <Td className="align-top">
                                            <div className={`tabular-nums ${pay.tone}`}>{pay.main}</div>
                                            {pay.sub && <div className="text-xs text-gray-500">{pay.sub}</div>}
                                            {b.paymentStatus !== 'paid' && (
                                                <div className="text-xs tabular-nums text-gray-500">Price {formatInr(b.totalAmount)}</div>
                                            )}
                                        </Td>
                                        <Td className="whitespace-nowrap align-top text-gray-400">
                                            {day(b.createdAt, FULL)}
                                        </Td>
                                    </tr>
                                );
                            })}
                        </TBody>
                    </Table>
                )}

                {!loading && !error && (
                    <Pagination currentPage={data?.currentPage || params.page} totalPages={data?.totalPages || 0} onChange={(page) => set({ page })} />
                )}
            </Card>
        </div>
    );
}
