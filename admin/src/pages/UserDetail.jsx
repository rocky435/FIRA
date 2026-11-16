import { useCallback, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
    BadgeCheck, Mail, MailCheck, MailX, Phone, MapPin, Briefcase, CalendarDays, Ban, RotateCcw,
    IndianRupee, Ticket, IdCard,
} from 'lucide-react';
import adminApi from '../api/adminApi';
import { formatInr } from '../lib/formatInr';
import { getAdminRoleFromToken } from '../lib/adminRole';
import { useRemote } from '../lib/useRemote';
import { humanize } from '../lib/statusStyles';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { StatCard } from '../components/ui/StatCard';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Button } from '../components/ui/Button';
import { ErrorState, EmptyState, PageSkeleton } from '../components/ui/States';
import { useConfirm } from '../components/ui/confirmContext';
import { useToast } from '../components/ui/toastContext';
import { OwnerCommissionCard } from '../components/Commission';

const formatDate = (value) => {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

/** Roles from `roles` (source of truth), falling back to legacy `role`; adminRole as its own entry. */
function roleLabels(user) {
    const labels = Array.isArray(user.roles) && user.roles.length ? [...user.roles] : (user.role ? [user.role] : []);
    if (user.adminRole && !labels.includes(user.adminRole)) labels.push(user.adminRole);
    return labels.length ? labels : ['user'];
}

function DetailRow({ icon, label, children }) {
    const Icon = icon;
    return (
        <div className="flex items-start gap-3 py-2.5">
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
            <dt className="w-28 shrink-0 text-sm text-gray-400">{label}</dt>
            <dd className="min-w-0 flex-1 break-words text-sm text-white">{children}</dd>
        </div>
    );
}

export default function UserDetail() {
    const { id } = useParams();
    const confirm = useConfirm();
    const toast = useToast();
    const loadUser = useCallback(() => adminApi.getUserById(id), [id]);
    const { data: user, loading, error, reload: fetchUser } = useRemote(loadUser);
    const [busy, setBusy] = useState(false);
    const canReviewIds = getAdminRoleFromToken() !== 'moderator';

    const setBlocked = async (block) => {
        const name = user?.name || 'this user';
        const ok = await confirm(block
            ? { title: `Block ${name}?`, message: 'They will be signed out and lose access to their account until unblocked.', confirmLabel: 'Block user', tone: 'danger' }
            : { title: `Unblock ${name}?`, message: 'They will regain full access to their account.', confirmLabel: 'Unblock user' });
        if (!ok) return;
        setBusy(true);
        try {
            await (block ? adminApi.blockUser(id) : adminApi.unblockUser(id));
            toast.success(block ? `${name} is blocked` : `${name} is unblocked`);
            await fetchUser();
        } catch (err) {
            toast.error(err?.message || `Could not ${block ? 'block' : 'unblock'} ${name}`);
        } finally {
            setBusy(false);
        }
    };

    if (loading && !error) return <PageSkeleton />;

    // Navigated from one user to another: the previous user's data is still
    // held while the new one loads, so check it is the one in the URL.
    if (user && user._id !== id && !error) return <PageSkeleton />;

    if (error || !user) {
        return (
            <div className="p-4 sm:p-6 lg:p-8">
                <PageHeader title="User" backTo="/users" backLabel="Back to users" />
                <Card>
                    <ErrorState
                        title={error ? "Couldn't load this user" : 'User not found'}
                        message={error || 'This account may have been deleted.'}
                        onRetry={error ? fetchUser : undefined}
                    />
                </Card>
            </div>
        );
    }

    const { stats, bookings = [], tickets = [] } = user;
    const badge = user.verificationBadge && user.verificationBadge !== 'none' ? user.verificationBadge : null;
    const hasIdChecks = (user.govIdStatus && user.govIdStatus !== 'none') || (user.panStatus && user.panStatus !== 'none');

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader
                title={
                    <span className="flex flex-wrap items-center gap-2">
                        {user.name}
                        {user.isVerified && (
                            <BadgeCheck className="h-6 w-6 text-violet-300" aria-label="Verified" />
                        )}
                    </span>
                }
                backTo="/users"
                backLabel="Back to users"
                actions={user.isBlocked ? (
                    <Button variant="secondary" onClick={() => setBlocked(false)} isLoading={busy} leftIcon={<RotateCcw className="h-4 w-4" aria-hidden="true" />}>
                        Unblock user
                    </Button>
                ) : (
                    <Button variant="danger" onClick={() => setBlocked(true)} isLoading={busy} leftIcon={<Ban className="h-4 w-4" aria-hidden="true" />}>
                        Block user
                    </Button>
                )}
            >
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <StatusBadge value={user.isBlocked ? 'blocked' : 'active'} />
                    {roleLabels(user).map((label) => <StatusBadge key={label} value={label} />)}
                    {badge && <StatusBadge tone="accent" icon={BadgeCheck}>{humanize(badge)}</StatusBadge>}
                </div>
            </PageHeader>

            <div className="grid gap-4 sm:grid-cols-3">
                <StatCard label="Total spent" value={formatInr(stats?.totalSpent || 0)} icon={IndianRupee} accent="blue" />
                <StatCard label="Venue bookings" value={(stats?.totalBookings || 0).toLocaleString('en-IN')} icon={CalendarDays} accent="violet" />
                <StatCard label="Tickets bought" value={(stats?.totalTickets || 0).toLocaleString('en-IN')} icon={Ticket} accent="pink" />
            </div>

            <div className="mt-6 grid gap-6 lg:grid-cols-3">
                <Card title="Account" className="lg:col-span-1">
                    <dl className="divide-y divide-line">
                        <DetailRow icon={Mail} label="Email">{user.email || '—'}</DetailRow>
                        <DetailRow icon={user.emailVerified ? MailCheck : MailX} label="Email status">
                            {user.emailVerified
                                ? <StatusBadge tone="success">Verified</StatusBadge>
                                : <StatusBadge tone="warning">Not verified</StatusBadge>}
                        </DetailRow>
                        <DetailRow icon={Phone} label="Phone">{user.phone || user.businessPhone || '—'}</DetailRow>
                        <DetailRow icon={MapPin} label="City">{user.city || '—'}</DetailRow>
                        {user.businessName && <DetailRow icon={Briefcase} label="Business">{user.businessName}</DetailRow>}
                        <DetailRow icon={BadgeCheck} label="Creator">
                            {user.isVerified
                                ? <StatusBadge tone="accent">{badge ? `Verified ${humanize(badge)}` : 'Verified'}</StatusBadge>
                                : <span className="text-gray-400">Not verified</span>}
                        </DetailRow>
                        <DetailRow icon={CalendarDays} label="Joined">{formatDate(user.createdAt) || '—'}</DetailRow>
                    </dl>
                </Card>

                <div className="space-y-6 lg:col-span-2">
                    {hasIdChecks && (
                        <Card
                            title="ID checks"
                            description="Government ID for venue owners, PAN for event organisers"
                            actions={canReviewIds ? (
                                <Link to="/id-checks" className="text-sm text-violet-300 hover:text-violet-200">Open ID checks</Link>
                            ) : null}
                        >
                            <dl className="grid gap-3 sm:grid-cols-2">
                                {[{ label: 'Government ID', status: user.govIdStatus, reason: user.govIdRejectionReason },
                                  { label: 'PAN', status: user.panStatus, reason: user.panRejectionReason }].map((c) => (
                                    <div key={c.label} className="rounded-xl border border-line bg-surface-raised p-3.5">
                                        <dt className="flex items-center gap-2 text-xs text-gray-400">
                                            <IdCard className="h-3.5 w-3.5" aria-hidden="true" />
                                            {c.label}
                                        </dt>
                                        <dd className="mt-2">
                                            <StatusBadge value={c.status && c.status !== 'none' ? c.status : 'none'}>
                                                {c.status && c.status !== 'none' ? humanize(c.status) : 'Not submitted'}
                                            </StatusBadge>
                                            {c.status === 'rejected' && c.reason && (
                                                <p className="mt-2 text-xs text-gray-400">Reason: {c.reason}</p>
                                            )}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        </Card>
                    )}

                    {/* What FIRA keeps from this person's event and venue payouts. */}
                    <OwnerCommissionCard userId={user._id} name={user.name} />

                    <div className="grid gap-6 xl:grid-cols-2">
                        <Card title="Recent bookings" padded={false}>
                            {bookings.length === 0 ? (
                                <EmptyState icon={CalendarDays} title="No bookings" className="py-10" />
                            ) : (
                                <ul className="divide-y divide-line border-t border-line">
                                    {bookings.slice(0, 5).map((booking) => (
                                        <li key={booking._id} className="flex items-center justify-between gap-3 px-5 py-3">
                                            <div className="min-w-0">
                                                <p className="truncate text-sm font-medium text-white">{booking.venue?.name || 'Unknown venue'}</p>
                                                <p className="text-xs text-gray-400">{formatDate(booking.bookingDate || booking.createdAt) || '—'}</p>
                                            </div>
                                            <div className="shrink-0 text-right">
                                                <p className="text-sm tabular-nums text-white">{formatInr(booking.totalAmount || 0)}</p>
                                                <StatusBadge value={booking.status} className="mt-1" />
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Card>

                        <Card title="Recent tickets" padded={false}>
                            {tickets.length === 0 ? (
                                <EmptyState icon={Ticket} title="No tickets" className="py-10" />
                            ) : (
                                <ul className="divide-y divide-line border-t border-line">
                                    {tickets.slice(0, 5).map((ticket) => (
                                        <li key={ticket._id} className="flex items-center justify-between gap-3 px-5 py-3">
                                            <div className="min-w-0">
                                                {ticket.event?._id ? (
                                                    <Link to={`/events/${ticket.event._id}`} className="block truncate text-sm font-medium text-white hover:text-violet-300">
                                                        {ticket.event.name}
                                                    </Link>
                                                ) : (
                                                    <p className="truncate text-sm font-medium text-white">Unknown event</p>
                                                )}
                                                <p className="truncate text-xs text-gray-400">
                                                    {[ticket.event?.venue?.name, formatDate(ticket.event?.startDateTime)].filter(Boolean).join(' · ') || '—'}
                                                </p>
                                            </div>
                                            <div className="shrink-0 text-right">
                                                <p className="text-sm tabular-nums text-white">{formatInr(ticket.price || 0)}</p>
                                                {/* Which category - an event can have several. */}
                                                <p className="text-xs text-gray-400">{ticket.ticketType ? `${humanize(ticket.ticketType)} ` : ''}× {ticket.quantity || 1}</p>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Card>
                    </div>
                </div>
            </div>
        </div>
    );
}
