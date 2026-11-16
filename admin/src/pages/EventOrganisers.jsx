import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Megaphone, IdCard, BadgeCheck, Ticket } from 'lucide-react';
import adminApi from '../api/adminApi';
import { useListParams } from '../lib/useListParams';
import { useRemote } from '../lib/useRemote';
import { formatDateTime } from '../lib/formatDateTime';
import { cn } from '../lib/cn';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { SearchInput } from '../components/ui/SearchInput';
import { StatusBadge } from '../components/ui/StatusBadge';
import { EmptyState, ErrorState, TableSkeleton } from '../components/ui/States';
import { IdentityReviewLoader } from '../components/IdentityReview';
import BankDetails from '../components/BankDetails';
import { OwnerCommissionCard } from '../components/Commission';

// An organiser's ticket earnings are paid out only once their PAN is verified,
// so it is shown on the row without expanding.
const PAN_LABEL = { verified: 'PAN verified', pending: 'PAN waiting for review', rejected: 'PAN rejected' };
function PanStatus({ status }) {
    const tone = { verified: 'success', pending: 'warning', rejected: 'danger' }[status] || 'neutral';
    return <StatusBadge tone={tone} icon={IdCard}>{PAN_LABEL[status] || 'PAN not submitted'}</StatusBadge>;
}

/**
 * Everyone who organises events: their events, PAN, bank details and FIRA's
 * commission on their payouts - the organiser counterpart of Venue Owners.
 */
export default function EventOrganisers() {
    const { params, set } = useListParams({ q: '' });
    const load = useCallback(() => adminApi.getEventOrganisers(params.q ? { search: params.q } : {}), [params.q]);
    const { data, loading, refreshing, error, reload } = useRemote(load);
    const organisers = data?.organisers || [];
    const [openId, setOpenId] = useState(null);

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader title="Event Organisers" description="Organisers, their events, PAN and payouts" count={loading ? null : organisers.length} />

            <div className="mb-4 flex justify-end">
                <SearchInput value={params.q} onSearch={(q) => set({ q })} placeholder="Search name or email" label="Search event organisers" />
            </div>

            <Card padded={false} aria-busy={loading || refreshing || undefined} className={cn('overflow-hidden transition-opacity', refreshing && 'opacity-60')}>
                {error ? (
                    <ErrorState title="Couldn't load event organisers" message={error} onRetry={reload} />
                ) : loading ? (
                    <TableSkeleton rows={5} columns={3} />
                ) : organisers.length === 0 ? (
                    <EmptyState
                        icon={Megaphone}
                        title={params.q ? 'No organisers match this search' : 'No event organisers yet'}
                        message={params.q ? `Nothing found for "${params.q}".` : 'People appear here once they create an event.'}
                    />
                ) : (
                    <ul className="divide-y divide-line">
                        {organisers.map((o) => {
                            const open = openId === o._id;
                            const c = o.counts || {};
                            return (
                                <li key={o._id}>
                                    <button
                                        type="button"
                                        onClick={() => setOpenId(open ? null : o._id)}
                                        aria-expanded={open}
                                        className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-hover"
                                    >
                                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-pink-500/15 text-sm font-semibold text-pink-200">
                                            {(o.name?.charAt(0) || 'O').toUpperCase()}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="flex flex-wrap items-center gap-2">
                                                <span className="text-sm font-semibold text-white">{o.name || 'Unnamed'}</span>
                                                {o.isVerified && <BadgeCheck className="h-4 w-4 text-violet-300" aria-label="Verified creator" />}
                                                <StatusBadge tone="accent">{c.total} event{c.total === 1 ? '' : 's'}</StatusBadge>
                                                {c.pending > 0 && <StatusBadge tone="warning">{c.pending} pending</StatusBadge>}
                                                <PanStatus status={o.panStatus} />
                                                {o.isBlocked && <StatusBadge value="blocked" />}
                                            </span>
                                            <span className="mt-1 block break-all text-xs text-gray-400">
                                                {o.email}
                                                {o.phone && ` · ${o.phone}`}
                                                {o.brand && ` · ${o.brand.name}`}
                                                {` · ${(c.ticketsSold || 0).toLocaleString('en-IN')} tickets sold`}
                                            </span>
                                        </span>
                                        <ChevronDown className={cn('h-4 w-4 shrink-0 text-gray-500 transition-transform', open && 'rotate-180')} aria-hidden="true" />
                                    </button>

                                    {open && (
                                        <div className="space-y-4 border-t border-line bg-white/[0.015] px-5 pb-5 pt-4 animate-fade-in">
                                            <div className="flex flex-wrap gap-3 text-sm">
                                                <Link to={`/users/${o._id}`} className="text-violet-300 hover:text-violet-200">Open their account</Link>
                                                {o.brand && <Link to={`/brands/${o.brand._id}`} className="text-violet-300 hover:text-violet-200">Creator profile</Link>}
                                            </div>
                                            <BankDetails bank={o.bankDetails} />
                                            {/* PAN must be verified before their ticket earnings are paid out. */}
                                            <IdentityReviewLoader userId={o._id} onChange={reload} />
                                            <OwnerCommissionCard userId={o._id} name={o.name} />

                                            <div>
                                                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Events</p>
                                                <div className="overflow-x-auto">
                                                    <table className="w-full text-left text-sm">
                                                        <thead className="border-b border-line">
                                                            <tr>
                                                                <th scope="col" className="pb-2 text-xs font-medium text-gray-400">Event</th>
                                                                <th scope="col" className="pb-2 text-xs font-medium text-gray-400">Starts</th>
                                                                <th scope="col" className="pb-2 text-xs font-medium text-gray-400">Tickets</th>
                                                                <th scope="col" className="pb-2 text-xs font-medium text-gray-400">Status</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-line">
                                                            {(o.events || []).map((e) => (
                                                                <tr key={e._id}>
                                                                    <td className="py-2 text-gray-200">
                                                                        <Link to={`/events/${e._id}`} className="inline-flex items-center gap-1.5 underline-offset-2 hover:text-white hover:underline">
                                                                            <Ticket className="h-3.5 w-3.5 text-pink-300" aria-hidden="true" />
                                                                            {e.name}
                                                                        </Link>
                                                                    </td>
                                                                    <td className="py-2 text-gray-400">{formatDateTime(e.startDateTime)}</td>
                                                                    <td className="py-2 tabular-nums text-gray-400">{(e.currentAttendees || 0).toLocaleString('en-IN')} / {(e.maxAttendees || 0).toLocaleString('en-IN')}</td>
                                                                    <td className="py-2"><StatusBadge value={e.status} /></td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </Card>
        </div>
    );
}
