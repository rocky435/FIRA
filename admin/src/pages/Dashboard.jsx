import { Link } from 'react-router-dom';
import {
    Building2, Ticket, Star, IdCard, Undo2, Users, ArrowRight, CircleCheck, Ban,
} from 'lucide-react';
import adminApi from '../api/adminApi';
import { getAdminRoleFromToken } from '../lib/adminRole';
import { useRemote } from '../lib/useRemote';
import { formatInr } from '../lib/formatInr';
import { PageHeader } from '../components/ui/PageHeader';
import { StatCard } from '../components/ui/StatCard';
import { Card } from '../components/ui/Card';
import { ErrorState, Skeleton } from '../components/ui/States';

const num = (n) => Number(n || 0).toLocaleString('en-IN');

// What can be waiting for an admin, and where to go to deal with it. `hideFor`
// mirrors the nav: moderators cannot act on refunds or ID checks.
const QUEUES = [
    { key: 'pendingVenues', label: 'Venues waiting for approval', to: '/venues?status=pending', icon: Building2 },
    { key: 'pendingEvents', label: 'Events waiting for approval', to: '/events?tab=pending', icon: Ticket },
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
    const waiting = queues.filter((q) => (stats?.[q.key] || 0) > 0);

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
                <div className="space-y-6 animate-fade-in">
                    {/* Headline numbers - each opens the list behind it */}
                    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
                        <StatCard label="Pending venues" value={num(stats.pendingVenues)} icon={Building2} accent="amber" to="/venues?status=pending" hint="Waiting for approval" />
                        <StatCard label="Pending events" value={num(stats.pendingEvents)} icon={Ticket} accent="amber" to="/events?tab=pending" hint="Waiting for approval" />
                        <StatCard label="Pending brands" value={num(stats.pendingBrands)} icon={Star} accent="pink" to="/brands?status=pending" hint="Waiting for approval" />
                        <StatCard label="Total users" value={num(stats.totalUsers)} icon={Users} accent="violet" to={adminRole === 'moderator' ? undefined : '/users'} hint={`${num(stats.blockedUsers)} blocked`} />
                    </div>

                    <div className="grid gap-6 lg:grid-cols-5">
                        {/* Work queue */}
                        <Card
                            className="lg:col-span-3"
                            title="Needs attention"
                            description={waiting.length ? `${waiting.length} ${waiting.length === 1 ? 'queue has' : 'queues have'} work waiting` : 'Nothing is waiting'}
                            padded={false}
                        >
                            {waiting.length === 0 ? (
                                <div className="flex items-center gap-3 px-5 pb-6 pt-1 text-sm text-gray-300">
                                    <CircleCheck className="h-5 w-5 text-green-400" aria-hidden="true" />
                                    All caught up. New approvals, ID checks and refunds will show up here.
                                </div>
                            ) : (
                                <ul className="divide-y divide-line border-t border-line">
                                    {queues.map((q) => {
                                        const count = stats?.[q.key] || 0;
                                        const Icon = q.icon;
                                        return (
                                            <li key={q.key}>
                                                <Link
                                                    to={q.to}
                                                    className="group flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-hover"
                                                >
                                                    <Icon className="h-[18px] w-[18px] shrink-0 text-gray-400" aria-hidden="true" />
                                                    <span className={count ? 'flex-1 text-sm text-white' : 'flex-1 text-sm text-gray-500'}>{q.label}</span>
                                                    <span className={count
                                                        ? 'rounded-full bg-amber-400/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-amber-300'
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

                        {/* Revenue */}
                        <Card className="lg:col-span-2" title="Platform revenue" description="Ticket sales and paid venue bookings">
                            <div className="text-3xl font-semibold tabular-nums text-white">{formatInr(stats.totalRevenue || 0)}</div>
                            <dl className="mt-5 grid grid-cols-2 gap-3">
                                <div className="rounded-xl border border-line bg-surface-raised p-3.5">
                                    <dt className="text-xs text-gray-400">Tickets</dt>
                                    <dd className="mt-1 text-base font-semibold tabular-nums text-white">{formatInr(stats.ticketRevenue || 0)}</dd>
                                    <dd className="mt-0.5 text-xs text-gray-500">{num(stats.totalTickets)} sold</dd>
                                </div>
                                <div className="rounded-xl border border-line bg-surface-raised p-3.5">
                                    <dt className="text-xs text-gray-400">Venue bookings</dt>
                                    <dd className="mt-1 text-base font-semibold tabular-nums text-white">{formatInr(stats.venueRevenue || 0)}</dd>
                                    <dd className="mt-0.5 text-xs text-gray-500">received so far</dd>
                                </div>
                            </dl>
                        </Card>
                    </div>

                    {/* Platform totals */}
                    <Card title="Platform totals" padded={false}>
                        <dl className="grid grid-cols-2 divide-line border-t border-line sm:grid-cols-4 sm:divide-x">
                            {[
                                { label: 'Venues', value: stats.totalVenues, to: '/venues' },
                                { label: 'Events', value: stats.totalEvents, to: '/events' },
                                { label: 'Brands', value: stats.totalBrands, to: '/brands' },
                                { label: 'Tickets sold', value: stats.totalTickets },
                            ].map((t) => (
                                <div key={t.label} className="px-5 py-4">
                                    <dt className="text-xs text-gray-400">{t.label}</dt>
                                    <dd className="mt-1 text-xl font-semibold tabular-nums text-white">
                                        {t.to ? <Link to={t.to} className="hover:text-violet-300">{num(t.value)}</Link> : num(t.value)}
                                    </dd>
                                </div>
                            ))}
                        </dl>
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
