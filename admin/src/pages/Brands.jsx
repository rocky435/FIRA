import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, Check, X, Ban, RotateCcw, Trash2, BadgeCheck } from 'lucide-react';
import adminApi from '../api/adminApi';
import { useListParams } from '../lib/useListParams';
import { useRemote } from '../lib/useRemote';
import { useBulkSelection } from '../lib/useBulkSelection';
import { useBulkRunner } from '../lib/useBulkRunner';
import { brandActions, brandAvailable, brandDeleteMessage, useConfirmedAction } from '../lib/listingActions';
import { humanize } from '../lib/statusStyles';
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

const loadPendingCount = () => adminApi.getBrands({ status: 'pending', limit: 1 });

export default function Brands() {
    const navigate = useNavigate();
    const runAction = useConfirmedAction();
    // Opened from the dashboard as ?status=pending: starts on that filter.
    const { params, set } = useListParams({ status: 'all', q: '', page: 1 });
    const status = STATUSES.includes(params.status) ? params.status : 'all';

    const loadBrands = useCallback(() => {
        const query = { page: params.page, limit: ITEMS_PER_PAGE };
        if (status !== 'all') query.status = status;
        if (params.q) query.search = params.q;
        return adminApi.getBrands(query);
    }, [params.page, params.q, status]);
    const { data, loading, refreshing, error, reload } = useRemote(loadBrands);
    // Platform-wide pending count (the old header badge counted only this page).
    const { data: pendingData, reload: reloadPending } = useRemote(loadPendingCount);

    const brands = data?.brands || [];
    const totalPages = data?.totalPages || 1;
    const total = data?.total || 0;
    const pendingTotal = pendingData?.total || 0;

    const bulk = useBulkSelection();
    const pageIds = brands.map((b) => b._id);
    const refresh = () => { reload(); reloadPending(); };

    // One action on one creator, worded the same as on the creator's own page.
    const act = async (brand, key) => { if (await runAction(brandActions(brand)[key])) refresh(); };

    const { busy: bulkBusy, run } = useBulkRunner({ bulk, reload: refresh, noun: ['creator', 'creators'] });
    const bulkActions = [
        { label: 'Approve', onClick: () => run({ verb: 'Approve', past: 'Approved', fn: (id) => adminApi.updateBrandStatus(id, 'approved') }) },
        { label: 'Reject', variant: 'danger', onClick: () => run({ verb: 'Reject', past: 'Rejected', danger: true, fn: (id) => adminApi.updateBrandStatus(id, 'rejected') }) },
        { label: 'Block', variant: 'danger', onClick: () => run({ verb: 'Block', past: 'Blocked', danger: true, fn: (id) => adminApi.updateBrandStatus(id, 'blocked') }) },
        { label: 'Delete', variant: 'danger', onClick: () => run({ verb: 'Delete', past: 'Deleted', danger: true, requireText: 'DELETE', message: brandDeleteMessage('each owner'), fn: (id) => adminApi.deleteBrand(id) }) },
    ];

    const tabs = STATUSES.map((s) => ({
        value: s,
        label: s.charAt(0).toUpperCase() + s.slice(1),
        count: s === 'pending' ? pendingTotal : undefined,
    }));

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader title="Creators" description="Manage and approve creator profiles" count={loading ? null : total} />

            <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <FilterTabs label="Creator status" options={tabs} value={status} onChange={(v) => set({ status: v })} />
                <SearchInput value={params.q} onSearch={(q) => set({ q })} placeholder="Search creators" label="Search creators" />
            </div>

            <BulkActionBar count={bulk.count} actions={bulkActions} onClear={bulk.clear} busy={bulkBusy} />

            <Card padded={false} aria-busy={loading || refreshing || undefined} className={`overflow-hidden transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
                {error ? (
                    <ErrorState title="Couldn't load creators" message={error} onRetry={reload} />
                ) : loading ? (
                    <TableSkeleton rows={6} columns={6} />
                ) : brands.length === 0 ? (
                    <EmptyState
                        icon={Star}
                        title={params.q || status !== 'all' ? 'No creators match these filters' : 'No creators yet'}
                        message={params.q ? `Nothing found for "${params.q}".` : undefined}
                    />
                ) : (
                    <Table label="Creators">
                        <THead>
                            <Th className="w-10">
                                <RowCheckbox checked={bulk.isPageAllSelected(pageIds)} onChange={() => bulk.togglePage(pageIds)} label="Select all on this page" />
                            </Th>
                            <Th>Creator</Th>
                            <Th>Owner</Th>
                            <Th>Type</Th>
                            <Th>Followers</Th>
                            <Th>Events</Th>
                            <Th>Status</Th>
                            <Th className="text-right">Actions</Th>
                        </THead>
                        <TBody>
                            {brands.map((brand) => {
                                const owner = brand.owner || brand.user;
                                const badge = owner?.verificationBadge && owner.verificationBadge !== 'none' ? owner.verificationBadge : null;
                                return (
                                    <tr
                                        key={brand._id}
                                        onClick={() => navigate(`/brands/${brand._id}`)}
                                        className={`cursor-pointer ${bulk.isSelected(brand._id) ? 'bg-violet-500/[0.06]' : ''}`}
                                    >
                                        <Td onClick={(e) => e.stopPropagation()}>
                                            <RowCheckbox checked={bulk.isSelected(brand._id)} onChange={() => bulk.toggle(brand._id)} label={`Select ${brand.name}`} />
                                        </Td>
                                        <Td>
                                            <div className="flex items-center gap-3">
                                                <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/[0.06] text-sm font-medium text-white">
                                                    {brand.profilePhoto
                                                        ? <img src={brand.profilePhoto} alt="" className="h-full w-full object-cover" />
                                                        : (brand.name?.charAt(0) || 'C').toUpperCase()}
                                                </span>
                                                <span className="font-medium text-white">{brand.name}</span>
                                            </div>
                                        </Td>
                                        <Td>
                                            <p className="flex items-center gap-1 text-white">
                                                {owner?.name || '—'}
                                                {owner?.isVerified && (
                                                    <BadgeCheck className="h-4 w-4 text-violet-300" aria-label={badge ? `Verified ${humanize(badge)}` : 'Verified'} />
                                                )}
                                            </p>
                                            <p className="text-xs text-gray-400">{owner?.email}</p>
                                        </Td>
                                        <Td>{humanize(brand.type) || 'Individual'}</Td>
                                        <Td className="tabular-nums">{(brand.followersCount || 0).toLocaleString('en-IN')}</Td>
                                        <Td className="tabular-nums">{brand.eventsCount || 0}</Td>
                                        <Td><StatusBadge value={brand.status} /></Td>
                                        <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                                            <div className="flex items-center justify-end gap-1">
                                                {brandAvailable(brand).approve && (
                                                    <>
                                                        <IconButton label={`Approve ${brand.name}`} tone="success" icon={Check} onClick={() => act(brand, 'approve')} />
                                                        <IconButton label={`Reject ${brand.name}`} tone="danger" icon={X} onClick={() => act(brand, 'reject')} />
                                                    </>
                                                )}
                                                {brandAvailable(brand).block && (
                                                    <IconButton label={`Block ${brand.name}`} tone="danger" icon={Ban} onClick={() => act(brand, 'block')} />
                                                )}
                                                {brandAvailable(brand).unblock && (
                                                    <IconButton label={`Unblock ${brand.name}`} tone="success" icon={RotateCcw} onClick={() => act(brand, 'unblock')} />
                                                )}
                                                {/* Delete is offered on every row, whatever the status: its
                                                    purpose is to free the owner to re-apply, which is as valid
                                                    for a rejected or blocked profile as an approved one. */}
                                                <IconButton label={`Delete creator ${brand.name}`} tone="danger" icon={Trash2} onClick={() => act(brand, 'remove')} />
                                            </div>
                                        </Td>
                                    </tr>
                                );
                            })}
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
