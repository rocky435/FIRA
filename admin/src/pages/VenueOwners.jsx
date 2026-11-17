import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, UsersRound, IdCard, UserMinus } from 'lucide-react';
import adminApi from '../api/adminApi';
import { useListParams } from '../lib/useListParams';
import { useRemote } from '../lib/useRemote';
import { cn } from '../lib/cn';
import { getAdminRoleFromToken } from '../lib/adminRole';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { SearchInput } from '../components/ui/SearchInput';
import { FilterTabs } from '../components/ui/FilterTabs';
import { Button } from '../components/ui/Button';
import { useConfirm } from '../components/ui/confirmContext';
import { useToast } from '../components/ui/toastContext';
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

const SHOW = [
    { value: 'all', label: 'All' },
    { value: 'none', label: 'No venues yet' },
    { value: 'listed', label: 'With venues' },
];

export default function VenueOwners() {
    const confirm = useConfirm();
    const toast = useToast();
    // Moderators cannot remove access (the server refuses too).
    const canRemove = getAdminRoleFromToken() !== 'moderator';
    const { params, set } = useListParams({ q: '', show: 'all' });
    const show = SHOW.some((s) => s.value === params.show) ? params.show : 'all';
    const loadOwners = useCallback(
        () => adminApi.getVenueOwners(params.q ? { search: params.q } : {}),
        [params.q]
    );
    const { data, loading, refreshing, error, reload } = useRemote(loadOwners);
    const everyone = data?.owners || [];
    const withoutVenues = everyone.filter((o) => !(o.venues || []).length).length;
    const owners = everyone.filter((o) => show === 'all' || (show === 'none') === !(o.venues || []).length);
    const [expandedId, setExpandedId] = useState(null);
    const [removing, setRemoving] = useState(null);

    // The account stays; only the host side goes, and "Become a host" starts over.
    const removeAccess = async (owner) => {
        const who = owner.name || 'this person';
        const ok = await confirm({
            title: `Remove venue owner access for ${who}?`,
            message: 'Their FIRA account, tickets and bookings stay. Their host details and ID are cleared: to list a venue again they apply through "Become a host" and their ID is reviewed again.',
            confirmLabel: 'Remove access',
            tone: 'danger',
        });
        if (!ok) return;
        setRemoving(owner._id);
        try {
            await adminApi.removeVenueOwnerAccess(owner._id);
            toast.success(`Venue owner access removed for ${who}`);
            setExpandedId(null);
            reload();
        } catch (err) {
            toast.error(err?.message || 'Could not remove access');
        } finally {
            setRemoving(null);
        }
    };

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader title="Venue Owners" description="Everyone signed up as a host, with or without a venue" count={loading ? null : everyone.length} />

            <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <FilterTabs
                    label="Venue owners shown"
                    options={SHOW.map((s) => ({ ...s, count: s.value === 'none' ? withoutVenues : undefined }))}
                    value={show}
                    onChange={(v) => set({ show: v })}
                />
                <SearchInput value={params.q} onSearch={(q) => set({ q })} placeholder="Search name, email or phone" label="Search venue owners" />
            </div>

            <Card padded={false} aria-busy={loading || refreshing || undefined} className={cn('overflow-hidden transition-opacity', refreshing && 'opacity-60')}>
                {error ? (
                    <ErrorState title="Couldn't load venue owners" message={error} onRetry={reload} />
                ) : loading ? (
                    <TableSkeleton rows={5} columns={3} />
                ) : owners.length === 0 ? (
                    <EmptyState
                        icon={UsersRound}
                        title={params.q ? 'No owners match this search' : show === 'none' ? 'Every venue owner has a venue' : 'No venue owners yet'}
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
                                                {venues.length
                                                    ? <StatusBadge tone="info">{venues.length} venue{venues.length === 1 ? '' : 's'}</StatusBadge>
                                                    : <StatusBadge tone="warning">No venues yet</StatusBadge>}
                                                <IdStatus status={owner.govIdStatus} />
                                            </span>
                                            <span className="mt-1 block break-all text-xs text-gray-400">
                                                {owner.businessName && <span className="text-gray-300">{owner.businessName} · </span>}
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
                                                    <p className="text-sm text-gray-500">No venues listed yet.</p>
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

                                            {canRemove && (
                                                <div className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
                                                    <p className="text-xs text-gray-500">
                                                        {venues.length
                                                            ? 'To remove their venue owner access, delete their venues first.'
                                                            : 'Removes only the venue owner side. Their account stays; they can apply again.'}
                                                    </p>
                                                    <Button
                                                        size="sm"
                                                        variant="danger"
                                                        disabled={venues.length > 0}
                                                        isLoading={removing === owner._id}
                                                        onClick={() => removeAccess(owner)}
                                                        leftIcon={<UserMinus className="h-4 w-4" aria-hidden="true" />}
                                                    >
                                                        Remove venue owner access
                                                    </Button>
                                                </div>
                                            )}
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
