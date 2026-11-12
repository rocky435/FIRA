import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Check, X, Ban, RotateCcw, Trash2, IdCard } from 'lucide-react';
import adminApi from '../api/adminApi';
import { useListParams } from '../lib/useListParams';
import { useRemote } from '../lib/useRemote';
import { useBulkSelection } from '../lib/useBulkSelection';
import { useBulkRunner } from '../lib/useBulkRunner';
import { venueActions, venueAvailable, VENUE_DELETE_MESSAGE, useConfirmedAction } from '../lib/listingActions';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { FilterTabs } from '../components/ui/FilterTabs';
import { SearchInput } from '../components/ui/SearchInput';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Table, THead, Th, TBody, Td } from '../components/ui/Table';
import { IconButton, RowCheckbox } from '../components/ui/IconButton';
import { Pagination } from '../components/ui/Pagination';
import { EmptyState, ErrorState, TableSkeleton } from '../components/ui/States';
import BulkActionBar from '../components/BulkActionBar';

const ITEMS_PER_PAGE = 10;
const STATUSES = ['all', 'pending', 'approved', 'rejected', 'blocked'];

// Format a venue capacity value for display. Capacity may be a plain
// number/string or an object like {min, max} or {seated, standing};
// rendering an object directly would print "[object Object]" (Flow 8.8).
const formatCapacity = (capacity) => {
    if (capacity === null || capacity === undefined || capacity === '') return '0';
    if (typeof capacity === 'number' || typeof capacity === 'string') {
        const num = Number(capacity);
        return Number.isFinite(num) ? num.toLocaleString() : String(capacity);
    }
    if (typeof capacity === 'object') {
        // Pick the two most meaningful numeric bounds present.
        const low = capacity.min ?? capacity.seated;
        const high = capacity.max ?? capacity.standing;
        const lowNum = Number(low);
        const highNum = Number(high);
        const hasLow = low != null && Number.isFinite(lowNum);
        const hasHigh = high != null && Number.isFinite(highNum);
        if (hasLow && hasHigh) return `${lowNum.toLocaleString()}–${highNum.toLocaleString()}`;
        if (hasHigh) return highNum.toLocaleString();
        if (hasLow) return lowNum.toLocaleString();
        // Fallback: first finite numeric value on the object, else "0".
        const firstNum = Object.values(capacity).map(Number).find(Number.isFinite);
        return firstNum != null ? firstNum.toLocaleString() : '0';
    }
    return '0';
};

const formatDate = (value) => {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

// How far the owner's government ID has got. A venue cannot be approved until
// it is verified, so an unverified one is flagged beside the owner.
function OwnerIdStatus({ status }) {
    if (status === 'verified') return null;
    const text = { pending: 'ID waiting for review', rejected: 'ID rejected' }[status] || 'ID not submitted';
    const tone = status === 'rejected' ? 'danger' : 'warning';
    return <StatusBadge tone={tone} icon={IdCard} className="mt-1">{text}</StatusBadge>;
}

const loadPendingCount = () => adminApi.getVenues({ status: 'pending', limit: 1 });

export default function Venues() {
    const navigate = useNavigate();
    const runAction = useConfirmedAction();
    // Opened from the dashboard as ?status=pending: starts on that filter.
    const { params, set } = useListParams({ status: 'all', q: '', page: 1 });
    const status = STATUSES.includes(params.status) ? params.status : 'all';

    const loadVenues = useCallback(() => {
        const query = { page: params.page, limit: ITEMS_PER_PAGE };
        if (status !== 'all') query.status = status;
        if (params.q) query.search = params.q;
        return adminApi.getVenues(query);
    }, [params.page, params.q, status]);
    const { data, loading, refreshing, error, reload } = useRemote(loadVenues);
    // The whole platform's pending count, not just this page's (the old header
    // badge counted only the ten rows on screen).
    const { data: pendingData, reload: reloadPending } = useRemote(loadPendingCount);

    const venues = data?.venues || [];
    const totalPages = data?.totalPages || 1;
    const total = data?.total || 0;
    const pendingTotal = pendingData?.total || 0;

    const bulk = useBulkSelection();
    const pageIds = venues.map((v) => v._id);
    const refresh = () => { reload(); reloadPending(); };

    // One action on one venue, worded the same as on the venue's own page.
    const act = async (venue, key) => { if (await runAction(venueActions(venue)[key])) refresh(); };

    // Carry on past a refused venue (e.g. its owner's ID is not verified yet) so
    // one does not stop the rest, then list what was refused and why.
    const { busy: bulkBusy, run } = useBulkRunner({ bulk, reload: refresh, noun: ['venue', 'venues'] });
    const bulkActions = [
        { label: 'Approve', onClick: () => run({ verb: 'Approve', past: 'Approved', continueOnError: true, fn: (id) => adminApi.updateVenueStatus(id, 'approved') }) },
        { label: 'Block', variant: 'danger', onClick: () => run({ verb: 'Block', past: 'Blocked', danger: true, continueOnError: true, fn: (id) => adminApi.updateVenueStatus(id, 'blocked') }) },
        { label: 'Delete', variant: 'danger', onClick: () => run({ verb: 'Delete', past: 'Deleted', danger: true, continueOnError: true, message: VENUE_DELETE_MESSAGE, requireText: 'DELETE', fn: (id) => adminApi.deleteVenue(id) }) },
    ];

    const tabs = STATUSES.map((s) => ({
        value: s,
        label: s.charAt(0).toUpperCase() + s.slice(1),
        count: s === 'pending' ? pendingTotal : undefined,
    }));

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader title="Venues" description="Manage and approve venue listings" count={loading ? null : total} />

            <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <FilterTabs label="Venue status" options={tabs} value={status} onChange={(v) => set({ status: v })} />
                <SearchInput value={params.q} onSearch={(q) => set({ q })} placeholder="Search name or city" label="Search venues" />
            </div>

            <BulkActionBar count={bulk.count} actions={bulkActions} onClear={bulk.clear} busy={bulkBusy} />

            <Card padded={false} aria-busy={loading || refreshing || undefined} className={`overflow-hidden transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
                {error ? (
                    <ErrorState title="Couldn't load venues" message={error} onRetry={reload} />
                ) : loading ? (
                    <TableSkeleton rows={6} columns={6} />
                ) : venues.length === 0 ? (
                    <EmptyState
                        icon={Building2}
                        title={params.q || status !== 'all' ? 'No venues match these filters' : 'No venues yet'}
                        message={params.q ? `Nothing found for "${params.q}".` : undefined}
                    />
                ) : (
                    <Table label="Venues">
                        <THead>
                            <Th className="w-10">
                                <RowCheckbox checked={bulk.isPageAllSelected(pageIds)} onChange={() => bulk.togglePage(pageIds)} label="Select all on this page" />
                            </Th>
                            <Th>Venue</Th>
                            <Th>Owner</Th>
                            <Th>City</Th>
                            <Th>Capacity</Th>
                            <Th>Status</Th>
                            <Th>Created</Th>
                            <Th className="text-right">Actions</Th>
                        </THead>
                        <TBody>
                            {venues.map((venue) => (
                                <tr
                                    key={venue._id}
                                    onClick={() => navigate(`/venues/${venue._id}`)}
                                    className={`cursor-pointer ${bulk.isSelected(venue._id) ? 'bg-violet-500/[0.06]' : ''}`}
                                >
                                    <Td onClick={(e) => e.stopPropagation()}>
                                        <RowCheckbox checked={bulk.isSelected(venue._id)} onChange={() => bulk.toggle(venue._id)} label={`Select ${venue.name}`} />
                                    </Td>
                                    <Td>
                                        <div className="flex items-center gap-3">
                                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-300">
                                                <Building2 className="h-4 w-4" aria-hidden="true" />
                                            </span>
                                            <div className="min-w-0">
                                                <p className="font-medium text-white">{venue.name}</p>
                                                {venue.deletionRequest?.requestedAt && (
                                                    <StatusBadge tone="danger" className="mt-1" title={venue.deletionRequest.reason || 'The owner asked for this venue to be removed'}>
                                                        Removal requested
                                                    </StatusBadge>
                                                )}
                                            </div>
                                        </div>
                                    </Td>
                                    <Td>
                                        <p className="text-white">{venue.owner?.name || '—'}</p>
                                        <p className="text-xs text-gray-400">{venue.owner?.email}</p>
                                        {venue.owner && <OwnerIdStatus status={venue.owner.govIdStatus} />}
                                    </Td>
                                    <Td>{venue.address?.city || '—'}</Td>
                                    <Td className="tabular-nums">{formatCapacity(venue.capacity)}</Td>
                                    <Td><StatusBadge value={venue.status} /></Td>
                                    <Td>{formatDate(venue.createdAt)}</Td>
                                    <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                                        <div className="flex items-center justify-end gap-1">
                                            {venueAvailable(venue).approve && (
                                                <>
                                                    <IconButton label={`Approve ${venue.name}`} tone="success" icon={Check} onClick={() => act(venue, 'approve')} />
                                                    <IconButton label={`Reject ${venue.name}`} tone="danger" icon={X} onClick={() => act(venue, 'reject')} />
                                                </>
                                            )}
                                            {venueAvailable(venue).block && (
                                                <IconButton label={`Block ${venue.name}`} tone="danger" icon={Ban} onClick={() => act(venue, 'block')} />
                                            )}
                                            {venueAvailable(venue).unblock && (
                                                <IconButton label={`Unblock ${venue.name}`} tone="success" icon={RotateCcw} onClick={() => act(venue, 'unblock')} />
                                            )}
                                            <IconButton label={`Delete venue ${venue.name}`} tone="danger" icon={Trash2} onClick={() => act(venue, 'remove')} />
                                        </div>
                                    </Td>
                                </tr>
                            ))}
                        </TBody>
                    </Table>
                )}

                {!loading && !error && (
                    <Pagination currentPage={params.page} totalPages={totalPages} onChange={(page) => set({ page })} />
                )}
            </Card>
        </div>
    );
}
