import { Link } from 'react-router-dom';
import {
    Building2, Ticket, Star, Wallet, IdCard, Undo2, Users, ArrowRight, CircleCheck, Ban, IndianRupee, ClipboardCheck,
} from 'lucide-react';
import adminApi from '../api/adminApi';
import { getAdminRoleFromToken } from '../lib/adminRole';
import { useRemote } from '../lib/useRemote';
import { formatInr } from '../lib/formatInr';
import { PageHeader } from '../components/ui/PageHeader';
import { StatCard } from '../components/ui/StatCard';
import { Card } from '../components/ui/Card';
import { ErrorState, Skeleton } from '../components/ui/States';
import { BarChart } from '../components/ui/BarChart';
import AfterRazorpay from '../components/AfterRazorpay';
import { gatewaySplit } from '../lib/useGatewayFee';

const num = (n) => Number(n || 0).toLocaleString('en-IN');
// Whole rupees for headline figures and chart labels.
const rupees = (n) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`;
// Short form for the chart axis: ₹1.2L, ₹45K.
const shortRupees = (n) => {
    if (n >= 1e7) return `₹${+(n / 1e7).toFixed(1)}Cr`;
    if (n >= 1e5) return `₹${+(n / 1e5).toFixed(1)}L`;
    if (n >= 1e3) return `₹${+(n / 1e3).toFixed(1)}K`;
    return `₹${Math.round(n)}`;
};
const countAxis = (n) => (n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const monthName = (key) => new Date(`${key}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short' });

/** % change from last month to this one; null when there is no last month to compare with. */
function change(series, pick) {
    if (!series || series.length < 2) return null;
    const now = pick(series[series.length - 1]);
    const before = pick(series[series.length - 2]);
    if (!before) return now ? null : 0;
    return ((now - before) / before) * 100;
}

/** One count per month as a short chart, titled with this month's figure. */
function MiniChart({ title, label, data }) {
    const latest = data[data.length - 1]?.value || 0;
    return (
        <div>
            <div className="mb-2 flex items-baseline justify-between gap-2">
                <h3 className="text-sm text-gray-300">{title}</h3>
                <p className="text-xs text-gray-500"><span className="font-semibold tabular-nums text-white">{num(latest)}</span> this month</p>
            </div>
            <BarChart label={label} data={data} format={num} axisFormat={countAxis} wholeNumbers steps={2} height={72} />
        </div>
    );
}

// What can be waiting for an admin, and where to go to deal with it. `hideFor`
// mirrors the nav: moderators cannot act on refunds or ID checks. `watch` rows
// are not admin work (someone else's step is due) but are worth keeping an eye
// on: shown in blue, and left out of the "work waiting" count.
const QUEUES = [
    { key: 'pendingVenues', label: 'Venues waiting for approval', to: '/venues?status=pending', icon: Building2 },
    { key: 'pendingEvents', label: 'Events waiting for approval', to: '/events?tab=pending', icon: Ticket },
    { key: 'eventsVenueUnpaid', label: 'Approved events waiting for venue payment', hint: 'The organiser has to pay', to: '/events?status=venue_unpaid', icon: Wallet, watch: true },
    { key: 'pendingBrands', label: 'Brands waiting for approval', to: '/brands?status=pending', icon: Star },
    { key: 'pendingIdChecks', label: 'ID documents to review', to: '/id-checks', icon: IdCard, hideFor: ['moderator'] },
    { key: 'pendingRefunds', label: 'Refunds to pay', to: '/refunds', icon: Undo2, hideFor: ['moderator'] },
];

function DashboardSkeleton() {
    return (
        <div className="space-y-6" role="status" aria-label="Loading dashboard">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[118px] rounded-2xl" />)}
            </div>
            <div className="grid gap-6 lg:grid-cols-5">
                <Skeleton className="h-72 rounded-2xl lg:col-span-3" />
                <Skeleton className="h-72 rounded-2xl lg:col-span-2" />
            </div>
            <div className="grid gap-6 lg:grid-cols-3">
                {[0, 1, 2].map((i) => <Skeleton key={i} className="h-80 rounded-2xl" />)}
            </div>
        </div>
    );
}

const loadStats = () => adminApi.getStats();

export default function Dashboard() {
    // Never fabricate figures on failure (an old fallback showed ₹4,50,000
    // revenue on a fresh, empty platform): an error shows the error, not numbers.
    const { data: stats, loading, error, reload } = useRemote(loadStats);
    const adminRole = getAdminRoleFromToken();

    const queues = QUEUES.filter((q) => !(q.hideFor || []).includes(adminRole));
    const trends = stats?.trends || [];
    const thisMonth = trends[trends.length - 1];
    const waiting = queues.filter((q) => !q.watch && (stats?.[q.key] || 0) > 0);
    const watching = queues.filter((q) => q.watch && (stats?.[q.key] || 0) > 0);

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader title="Dashboard" description="What needs your attention, and how the platform is doing." />

            {error ? (
                <Card>
                    <ErrorState title="Couldn't load the dashboard" message={error} onRetry={reload} />
                </Card>
            ) : loading || !stats ? (
                <DashboardSkeleton />
            ) : (
                <div className="space-y-6">
                    {/* This month at a glance, each compared with last month */}
                    <div className="stagger grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
                        <StatCard
                            label="Collected this month"
                            countTo={thisMonth ? thisMonth.ticketRevenue + thisMonth.venueRevenue : 0}
                            format={rupees}
                            trend={change(trends, (m) => m.ticketRevenue + m.venueRevenue)}
                            icon={IndianRupee}
                            accent="green"
                            hint={(() => {
                                const month = thisMonth ? thisMonth.ticketRevenue + thisMonth.venueRevenue : 0;
                                const split = gatewaySplit(month, stats.gatewayFeePercent);
                                return (
                                    <>
                                        {rupees(stats.totalRevenue)} all time
                                        <AfterRazorpay amount={month} after={split.after} fee={split.fee} percent={stats.gatewayFeePercent} />
                                    </>
                                );
                            })()}
                        />
                        <StatCard
                            label="Tickets sold this month"
                            countTo={thisMonth?.ticketsSold || 0}
                            trend={change(trends, (m) => m.ticketsSold)}
                            icon={Ticket}
                            accent="pink"
                            hint={`${num(stats.totalTickets)} all time`}
                        />
                        <StatCard
                            label="New users this month"
                            countTo={thisMonth?.newUsers || 0}
                            trend={change(trends, (m) => m.newUsers)}
                            icon={Users}
                            accent="blue"
                            to={adminRole === 'moderator' ? undefined : '/users'}
                            hint={`${num(stats.totalUsers)} in total`}
                        />
                        <StatCard
                            label="Waiting for review"
                            countTo={(stats.pendingVenues || 0) + (stats.pendingEvents || 0) + (stats.pendingBrands || 0)}
                            icon={ClipboardCheck}
                            accent="amber"
                            to={stats.pendingEvents ? '/events?tab=pending' : stats.pendingVenues ? '/venues?status=pending' : '/brands?status=pending'}
                            hint={[[stats.pendingVenues, 'venue'], [stats.pendingEvents, 'event'], [stats.pendingBrands, 'creator']].map(([n, w]) => `${num(n)} ${w}${n === 1 ? '' : 's'}`).join(' · ')}
                        />
                    </div>

                    <div className="stagger grid gap-6 lg:grid-cols-5">
                        {/* Work queue */}
                        <Card
                            className="lg:col-span-3"
                            title="Needs attention"
                            description={waiting.length ? `${waiting.length} ${waiting.length === 1 ? 'queue has' : 'queues have'} work waiting` : 'Nothing needs your action'}
                            padded={false}
                        >
                            {waiting.length === 0 && watching.length === 0 ? (
                                <div className="flex items-center gap-3 px-5 pb-6 pt-1 text-sm text-gray-300">
                                    <CircleCheck className="h-5 w-5 text-green-400" aria-hidden="true" />
                                    All caught up. New approvals, ID checks and refunds will show up here.
                                </div>
                            ) : (
                                <ul className="divide-y divide-line border-t border-line">
                                    {queues.map((q) => {
                                        const count = stats?.[q.key] || 0;
                                        const Icon = q.icon;
                                        // Amber: admin work. Blue: waiting on someone else.
                                        const tone = q.watch
                                            ? { icon: 'bg-blue-500/15 text-blue-300', pill: 'bg-blue-400/15 text-blue-300' }
                                            : { icon: 'bg-amber-500/15 text-amber-300', pill: 'bg-amber-400/15 text-amber-300' };
                                        return (
                                            <li key={q.key}>
                                                <Link
                                                    to={q.to}
                                                    className="group flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-hover"
                                                >
                                                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${count ? tone.icon : 'bg-white/[0.04] text-gray-500'}`}>
                                                        <Icon className="h-4 w-4" aria-hidden="true" />
                                                    </span>
                                                    <span className="min-w-0 flex-1">
                                                        <span className={count ? 'block text-sm text-white' : 'block text-sm text-gray-500'}>{q.label}</span>
                                                        {q.hint && count > 0 && <span className="block text-xs text-gray-500">{q.hint}</span>}
                                                    </span>
                                                    <span className={count
                                                        ? `rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${tone.pill}`
                                                        : 'text-xs tabular-nums text-gray-600'}>
                                                        {num(count)}
                                                    </span>
                                                    <ArrowRight className="h-4 w-4 text-gray-600 transition-transform group-hover:translate-x-0.5 group-hover:text-white" aria-hidden="true" />
                                                </Link>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </Card>

                        {/* Revenue: what guests paid, what Razorpay keeps, what is left */}
                        <Card className="lg:col-span-2" title="Platform revenue" description="Ticket sales and paid venue bookings">
                            <p className="text-xs text-gray-400">Collected from guests</p>
                            <div className="text-brand-grad text-3xl font-semibold tabular-nums">{formatInr(stats.totalRevenue || 0)}</div>
                            <dl className="mt-5 divide-y divide-line rounded-xl border border-line bg-surface-raised text-sm">
                                <div className="flex items-baseline justify-between gap-3 px-3.5 py-2.5">
                                    <dt className="text-gray-300">Tickets <span className="text-xs text-gray-500">· {num(stats.totalTickets)} sold</span></dt>
                                    <dd className="tabular-nums text-white">{formatInr(stats.ticketRevenue || 0)}</dd>
                                </div>
                                <div className="flex items-baseline justify-between gap-3 px-3.5 py-2.5">
                                    <dt className="text-gray-300">Venue bookings <span className="text-xs text-gray-500">· received so far</span></dt>
                                    <dd className="tabular-nums text-white">{formatInr(stats.venueRevenue || 0)}</dd>
                                </div>
                                <div className="flex items-baseline justify-between gap-3 px-3.5 py-2.5">
                                    <dt className="text-gray-300">
                                        Razorpay fee <span className="text-xs text-gray-500">· {stats.gatewayFeePercent ?? 2}%, estimated</span>
                                    </dt>
                                    <dd className="whitespace-nowrap tabular-nums text-red-300">−{formatInr(stats.gatewayFee || 0)}</dd>
                                </div>
                                <div className="flex items-baseline justify-between gap-3 px-3.5 py-3">
                                    <dt className="font-medium text-white">After Razorpay</dt>
                                    <dd className="text-base font-semibold tabular-nums text-white">{formatInr(stats.netRevenue || 0)}</dd>
                                </div>
                            </dl>
                        </Card>
                    </div>

                    {/* Six months of activity. Two counts on very different scales
                        (a handful of events, dozens of tickets) get a small chart each
                        rather than sharing one axis. */}
                    {trends.length > 0 && (
                        <div className="stagger grid gap-6 lg:grid-cols-3">
                            <Card title="Events & tickets" description="Events held and tickets sold, per month">
                                <div className="space-y-5">
                                    <MiniChart title="Events held" label="Events held per month" data={trends.map((m) => ({ label: monthName(m.month), value: m.eventsHeld || 0 }))} />
                                    <MiniChart title="Tickets sold" label="Tickets sold per month" data={trends.map((m) => ({ label: monthName(m.month), value: m.ticketsSold || 0 }))} />
                                </div>
                            </Card>
                            <Card title="Venue bookings" description="Bookings used and venues booked, per month">
                                <div className="space-y-5">
                                    <MiniChart title="Bookings" label="Venue bookings per month" data={trends.map((m) => ({ label: monthName(m.month), value: m.venueBookings || 0 }))} />
                                    <MiniChart title="Venues booked" label="Different venues booked per month" data={trends.map((m) => ({ label: monthName(m.month), value: m.venuesBooked || 0 }))} />
                                </div>
                            </Card>
                            <Card title="Money collected" description="Ticket sales and venue bookings paid, per month">
                                <BarChart
                                    label="Money collected per month"
                                    data={trends.map((m) => ({
                                        label: monthName(m.month),
                                        value: m.ticketRevenue + m.venueRevenue,
                                        detail: `Tickets ${rupees(m.ticketRevenue)} · Venues ${rupees(m.venueRevenue)} · After Razorpay ${rupees(gatewaySplit(m.ticketRevenue + m.venueRevenue, stats.gatewayFeePercent).after)}`,
                                    }))}
                                    format={rupees}
                                    axisFormat={shortRupees}
                                    height={236}
                                />
                            </Card>
                        </div>
                    )}

                    {/* Platform totals */}
                    <Card title="Platform totals" padded={false}>
                        <ul className="grid grid-cols-2 divide-line border-t border-line sm:grid-cols-4 sm:divide-x">
                            {[
                                { label: 'Venues', value: stats.totalVenues, to: '/venues' },
                                { label: 'Events', value: stats.totalEvents, to: '/events' },
                                { label: 'Brands', value: stats.totalBrands, to: '/brands' },
                                { label: 'Tickets sold', value: stats.totalTickets },
                            ].map((t) => {
                                const body = (
                                    <>
                                        <span className="flex items-center justify-between text-xs text-gray-400">
                                            {t.label}
                                            {t.to && <ArrowRight className="h-3.5 w-3.5 text-gray-600 transition-transform group-hover:translate-x-0.5 group-hover:text-white" aria-hidden="true" />}
                                        </span>
                                        <span className="mt-1 block text-xl font-semibold tabular-nums text-white">{num(t.value)}</span>
                                    </>
                                );
                                return (
                                    <li key={t.label}>
                                        {t.to ? (
                                            <Link
                                                to={t.to}
                                                className="group block h-full px-5 py-4 transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
                                            >
                                                {body}
                                            </Link>
                                        ) : (
                                            <div className="px-5 py-4">{body}</div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                        {stats.blockedUsers > 0 && (
                            <div className="flex items-center gap-2 border-t border-line px-5 py-3 text-sm text-red-300">
                                <Ban className="h-4 w-4" aria-hidden="true" />
                                {num(stats.blockedUsers)} blocked {stats.blockedUsers === 1 ? 'account' : 'accounts'}
                                {adminRole !== 'moderator' && (
                                    <Link to="/users?status=blocked" className="ml-auto text-xs text-gray-400 hover:text-white">View</Link>
                                )}
                            </div>
                        )}
                    </Card>
                </div>
            )}
        </div>
    );
}
