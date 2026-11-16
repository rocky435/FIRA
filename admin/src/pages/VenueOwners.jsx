import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, UsersRound, IdCard } from 'lucide-react';
import adminApi from '../api/adminApi';
import { useListParams } from '../lib/useListParams';
import { useRemote } from '../lib/useRemote';
import { cn } from '../lib/cn';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { SearchInput } from '../components/ui/SearchInput';
import { StatusBadge } from '../components/ui/StatusBadge';
import { EmptyState, ErrorState, TableSkeleton } from '../components/ui/States';
import { IdentityReviewLoader } from '../components/IdentityReview';
import BankDetails from '../components/BankDetails';
import { OwnerCommissionCard } from '../components/Commission';

const formatCapacity = (capacity) => {
    if (capacity == null) return '—';
    if (typeof capacity === 'object') {
        const { min, max } = capacity;
        if (min != null && max != null) return `${min}–${max}`;
        return String(min ?? max ?? '—');
    }
    return String(capacity);
};

// The owner's government ID, which must be verified before any of their venues
// can be approved - shown on the row so it can be seen without expanding.
const ID_LABEL = { verified: 'ID verified', pending: 'ID waiting for review', rejected: 'ID rejected' };
function IdStatus({ status }) {
    const tone = { verified: 'success', pending: 'warning', rejected: 'danger' }[status] || 'neutral';
    return <StatusBadge tone={tone} icon={IdCard}>{ID_LABEL[status] || 'ID not submitted'}</StatusBadge>;
}

export default function VenueOwners() {
    const { params, set } = useListParams({ q: '' });
    const loadOwners = useCallback(
        () => adminApi.getVenueOwners(params.q ? { search: params.q } : {}),
        [params.q]
    );
    const { data, loading, refreshing, error, reload } = useRemote(loadOwners);
    const owners = data?.owners || [];
    const [expandedId, setExpandedId] = useState(null);

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader title="Venue Owners" description="Owners and their venues" count={loading ? null : owners.length} />

            <div className="mb-4 flex justify-end">
                <SearchInput value={params.q} onSearch={(q) => set({ q })} placeholder="Search name or email" label="Search venue owners" />
            </div>

            <Card padded={false} aria-busy={loading || refreshing || undefined} className={cn('overflow-hidden transition-opacity', refreshing && 'opacity-60')}>
                {error ? (
                    <ErrorState title="Couldn't load venue owners" message={error} onRetry={reload} />
                ) : loading ? (
                    <TableSkeleton rows={5} columns={3} />
                ) : owners.length === 0 ? (
                    <EmptyState
                        icon={UsersRound}
                        title={params.q ? 'No owners match this search' : 'No venue owners yet'}
                        message={params.q ? `Nothing found for "${params.q}".` : undefined}
                    />
                ) : (
                    <ul className="divide-y divide-line">
                        {owners.map((owner) => {
                            const isOpen = expandedId === owner._id;
                            const venues = owner.venues || [];
                            return (
                                <li key={owner._id}>
                                    <button
                                        type="button"
                                        onClick={() => setExpandedId(isOpen ? null : owner._id)}
                                        aria-expanded={isOpen}
                                        className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-hover"
                                    >
                                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-sm font-medium text-white">
                                            {(owner.name?.charAt(0) || 'O').toUpperCase()}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="flex flex-wrap items-center gap-2">
                                                <span className="text-sm font-semibold text-white">{owner.name || 'Unnamed'}</span>
                                                <StatusBadge tone="info">{venues.length} venue{venues.length === 1 ? '' : 's'}</StatusBadge>
                                                <IdStatus status={owner.govIdStatus} />
                                            </span>
                                            <span className="mt-1 block break-all text-xs text-gray-400">
                                                {owner.email}
                                                {owner.phone && ` · ${owner.phone}`}
                                            </span>
                                        </span>
                                        <ChevronDown className={cn('h-4 w-4 shrink-0 text-gray-500 transition-transform', isOpen && 'rotate-180')} aria-hidden="true" />
                                    </button>

                                    {isOpen && (
                                        <div className="space-y-4 border-t border-line bg-white/[0.015] px-5 pb-5 pt-4">
                                            <BankDetails bank={owner.bankDetails} />
                                            {/* What FIRA keeps from this owner's venue payouts. */}
                                            <OwnerCommissionCard userId={owner._id} name={owner.name} />
                                            {/* The ID must be verified before any of their venues can be approved. */}
                                            {/* Reload after a review so the row's ID badge follows it. */}
                                            <IdentityReviewLoader userId={owner._id} onChange={reload} />

                                            <div>
                                                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Venues</p>
                                                {venues.length === 0 ? (
                                                    <p className="text-sm text-gray-500">No venues.</p>
                                                ) : (
                                                    <div className="overflow-x-auto">
                                                        <table className="w-full text-left text-sm">
                                                            <thead className="border-b border-line">
                                                                <tr>
                                                                    <th scope="col" className="pb-2 text-xs font-medium text-gray-400">Name</th>
                                                                    <th scope="col" className="pb-2 text-xs font-medium text-gray-400">City</th>
                                                                    <th scope="col" className="pb-2 text-xs font-medium text-gray-400">Capacity</th>
                                                                    <th scope="col" className="pb-2 text-xs font-medium text-gray-400">Status</th>
                                                                </tr>
                                                            </thead>
                                                            <tbody className="divide-y divide-line">
                                                                {venues.map((v) => (
                                                                    <tr key={v._id}>
                                                                        <td className="py-2 text-gray-200">
                                                                            <Link to={`/venues/${v._id}`} className="underline-offset-2 hover:text-white hover:underline">{v.name}</Link>
                                                                        </td>
                                                                        <td className="py-2 text-gray-400">{v.address?.city || '—'}</td>
                                                                        <td className="py-2 text-gray-400">{formatCapacity(v.capacity)}</td>
                                                                        <td className="py-2"><StatusBadge value={v.status || 'unknown'} /></td>
                                                                    </tr>
                                                                ))}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                )}
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
