import { useMemo, useState } from 'react';
import { Tag, ChevronDown, CalendarDays, Trash2, Power, PowerOff } from 'lucide-react';
import adminApi from '../api/adminApi';
import { useListParams } from '../lib/useListParams';
import { useRemote } from '../lib/useRemote';
import { useBulkSelection } from '../lib/useBulkSelection';
import { useBulkRunner } from '../lib/useBulkRunner';
import { formatInr } from '../lib/formatInr';
import { cn } from '../lib/cn';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { FilterTabs } from '../components/ui/FilterTabs';
import { SearchInput } from '../components/ui/SearchInput';
import { StatusBadge } from '../components/ui/StatusBadge';
import { IconButton, RowCheckbox } from '../components/ui/IconButton';
import { Button } from '../components/ui/Button';
import { Pagination } from '../components/ui/Pagination';
import { EmptyState, ErrorState, TableSkeleton, Skeleton } from '../components/ui/States';
import { useConfirm } from '../components/ui/confirmContext';
import { useToast } from '../components/ui/toastContext';
import BulkActionBar from '../components/BulkActionBar';
import { useGatewayFeePercent, gatewaySplit } from '../lib/useGatewayFee';

const PAGE_SIZE = 10;
const STATUSES = ['all', 'active', 'inactive'];

const formatDate = (d) => {
    if (!d) return 'N/A';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return 'Invalid';
    return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

// Flow 8.7: a code created by a user with an adminRole is a platform code
// (intended to apply to every event); otherwise it was created by the event owner.
const isAdminCode = (code) => Boolean(code.createdBy?.adminRole);

const loadCodes = () => adminApi.getDiscountCodes();

/** Level 3: usage figures for one code, fetched the first time it is opened. */
function CodeAnalytics({ entry }) {
    const feePercent = useGatewayFeePercent();
    if (!entry || entry.loading) {
        return (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="status" aria-label="Loading analytics">
                {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
            </div>
        );
    }
    if (entry.error) return <p role="alert" className="py-2 text-sm text-red-400">Failed to load analytics</p>;
    const a = entry.data;
    const tiles = [
        { label: 'Total uses', value: (a.totalUses || 0).toLocaleString('en-IN') },
        { label: 'Total revenue', value: formatInr(a.totalRevenue || 0) },
        ...(feePercent != null && a.totalRevenue > 0
            ? [{ label: `After Razorpay (−${feePercent}%)`, value: formatInr(gatewaySplit(a.totalRevenue, feePercent).after) }]
            : []),
        { label: 'Purchases', value: (a.purchases?.length || 0).toLocaleString('en-IN') },
    ];
    return (
        <div>
            <dl className={`mb-4 grid grid-cols-2 gap-3 ${tiles.length > 3 ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
                {tiles.map((t) => (
                    <div key={t.label} className="rounded-xl border border-line bg-surface-raised p-3">
                        <dt className="text-xs text-gray-400">{t.label}</dt>
                        <dd className="mt-0.5 text-lg font-semibold tabular-nums text-white">{t.value}</dd>
                    </div>
                ))}
            </dl>
            {a.purchases?.length > 0 && (
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="border-b border-line">
                            <tr>
                                <th scope="col" className="pb-2 text-xs font-medium text-gray-400">User</th>
                                <th scope="col" className="pb-2 text-xs font-medium text-gray-400">Amount</th>
                                <th scope="col" className="pb-2 text-xs font-medium text-gray-400">Date</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                            {a.purchases.map((p) => (
                                <tr key={p._id}>
                                    <td className="py-2 text-gray-300">{p.user?.name || p.user?.email || 'Unknown'}</td>
                                    <td className="py-2 tabular-nums text-gray-300">{formatInr(p.totalAmount || p.amount || 0)}</td>
                                    <td className="py-2 text-gray-500">{formatDate(p.createdAt)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

export default function DiscountCodes() {
    const confirm = useConfirm();
    const toast = useToast();
    const { params, set } = useListParams({ status: 'all', q: '', page: 1 });
    const status = STATUSES.includes(params.status) ? params.status : 'all';

    const { data, loading, refreshing, error, reload } = useRemote(loadCodes);
    const [expandedEventId, setExpandedEventId] = useState(null);
    const [expandedCodeId, setExpandedCodeId] = useState(null);
    const [analytics, setAnalytics] = useState({});
    const [toggling, setToggling] = useState({});
    const bulk = useBulkSelection();

    const codes = useMemo(() => (Array.isArray(data) ? data : []), [data]);

    // The API returns every code at once, so filter and search happen here.
    const visible = useMemo(() => {
        const q = params.q.toLowerCase();
        return codes.filter((c) => {
            if (status === 'active' && !c.isActive) return false;
            if (status === 'inactive' && c.isActive) return false;
            if (!q) return true;
            return String(c.code || '').toLowerCase().includes(q) || String(c.event?.name || '').toLowerCase().includes(q);
        });
    }, [codes, status, params.q]);

    // Group codes by event. Events are the top-level (paged) rows; each expands
    // to its codes, and each code expands again to its analytics.
    const groups = useMemo(() => {
        const byEvent = visible.reduce((acc, code) => {
            const key = String(code.event?._id || code.event || 'unknown');
            if (!acc[key]) acc[key] = { id: key, name: code.event?.name || 'Unknown Event', codes: [] };
            acc[key].codes.push(code);
            return acc;
        }, {});
        return Object.values(byEvent);
    }, [visible]);

    const totalPages = Math.max(Math.ceil(groups.length / PAGE_SIZE), 1);
    // Filtering/deletion can shrink the list under the current page; clamp on read
    // so the view never goes blank (mirrors client/usePaged).
    const page = Math.min(params.page, totalPages);
    const pageGroups = groups.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    // Bulk selection operates on individual codes on the current page.
    const pageCodeIds = pageGroups.flatMap((g) => g.codes.map((c) => c._id));
    const activeCount = codes.filter((c) => c.isActive).length;

    const toggleActive = async (code) => {
        const action = code.isActive ? 'Deactivate' : 'Activate';
        const ok = await confirm({
            title: `${action} "${code.code}"?`,
            message: code.isActive ? 'Buyers will no longer be able to use it.' : 'Buyers will be able to use it again.',
            confirmLabel: `${action} code`,
            tone: code.isActive ? 'danger' : undefined,
        });
        if (!ok) return;
        setToggling((prev) => ({ ...prev, [code._id]: true }));
        try {
            await (code.isActive ? adminApi.deactivateDiscountCode(code._id) : adminApi.activateDiscountCode(code._id));
            toast.success(`"${code.code}" is ${code.isActive ? 'deactivated' : 'active'}`);
            reload();
        } catch (err) {
            toast.error(err?.message || `Could not ${action.toLowerCase()} "${code.code}"`);
        } finally {
            setToggling((prev) => ({ ...prev, [code._id]: false }));
        }
    };

    const remove = async (code) => {
        const ok = await confirm({ title: `Delete "${code.code}"?`, message: 'This cannot be undone.', confirmLabel: 'Delete code', tone: 'danger' });
        if (!ok) return;
        try {
            await adminApi.deleteDiscountCode(code._id);
            toast.success(`"${code.code}" was deleted`);
            reload();
        } catch (err) {
            toast.error(err?.message || 'Failed to delete discount code');
        }
    };

    const openCode = async (codeId) => {
        if (expandedCodeId === codeId) {
            setExpandedCodeId(null);
            return;
        }
        setExpandedCodeId(codeId);
        if (analytics[codeId] && !analytics[codeId].error) return;
        setAnalytics((prev) => ({ ...prev, [codeId]: { loading: true } }));
        try {
            const result = await adminApi.getDiscountAnalytics(codeId);
            setAnalytics((prev) => ({ ...prev, [codeId]: { data: result } }));
        } catch {
            setAnalytics((prev) => ({ ...prev, [codeId]: { error: true } }));
        }
    };

    const { busy: bulkBusy, run } = useBulkRunner({ bulk, reload, noun: ['code', 'codes'] });
    const bulkActions = [
        { label: 'Activate', onClick: () => run({ verb: 'Activate', past: 'Activated', fn: (id) => adminApi.activateDiscountCode(id) }) },
        { label: 'Deactivate', onClick: () => run({ verb: 'Deactivate', past: 'Deactivated', danger: true, fn: (id) => adminApi.deactivateDiscountCode(id) }) },
        { label: 'Delete', variant: 'danger', onClick: () => run({ verb: 'Delete', past: 'Deleted', danger: true, message: 'This cannot be undone.', fn: (id) => adminApi.deleteDiscountCode(id) }) },
    ];

    const tabs = [
        { value: 'all', label: 'All', count: codes.length },
        { value: 'active', label: 'Active', count: activeCount },
        { value: 'inactive', label: 'Inactive', count: codes.length - activeCount },
    ];

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader
                title="Discount Codes"
                description={loading ? 'Manage discount codes' : `Manage discount codes · ${groups.length} ${groups.length === 1 ? 'event' : 'events'}`}
                count={loading ? null : codes.length}
            />

            <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <FilterTabs label="Code status" options={tabs} value={status} onChange={(v) => set({ status: v })} />
                <SearchInput value={params.q} onSearch={(q) => set({ q })} placeholder="Search code or event" label="Search discount codes" />
            </div>

            <BulkActionBar count={bulk.count} actions={bulkActions} onClear={bulk.clear} busy={bulkBusy} />

            <Card padded={false} aria-busy={loading || refreshing || undefined} className={cn('overflow-hidden transition-opacity', refreshing && 'opacity-60')}>
                {error ? (
                    <ErrorState title="Couldn't load discount codes" message={error} onRetry={reload} />
                ) : loading ? (
                    <TableSkeleton rows={5} columns={3} />
                ) : groups.length === 0 ? (
                    <EmptyState
                        icon={Tag}
                        title={codes.length ? 'No codes match these filters' : 'No discount codes yet'}
                        message={params.q ? `Nothing found for "${params.q}".` : undefined}
                    />
                ) : (
                    <>
                        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
                            <RowCheckbox checked={bulk.isPageAllSelected(pageCodeIds)} onChange={() => bulk.togglePage(pageCodeIds)} label="Select all codes on this page" />
                            <span className="text-xs text-gray-400">Select all on page</span>
                        </div>

                        <ul className="divide-y divide-line">
                            {pageGroups.map((group) => {
                                const eventOpen = expandedEventId === group.id;
                                return (
                                    <li key={group.id}>
                                        {/* Level 1: the event */}
                                        <button
                                            type="button"
                                            onClick={() => setExpandedEventId(eventOpen ? null : group.id)}
                                            aria-expanded={eventOpen}
                                            className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-hover"
                                        >
                                            <CalendarDays className="h-4 w-4 shrink-0 text-violet-300" aria-hidden="true" />
                                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">{group.name}</span>
                                            <span className="text-xs text-gray-500">{group.codes.length} code{group.codes.length !== 1 ? 's' : ''}</span>
                                            <ChevronDown className={cn('h-4 w-4 text-gray-500 transition-transform', eventOpen && 'rotate-180')} aria-hidden="true" />
                                        </button>

                                        {/* Level 2: its codes */}
                                        {eventOpen && (
                                            <ul className="divide-y divide-line border-t border-line bg-white/[0.015]">
                                                {group.codes.map((code) => {
                                                    const codeOpen = expandedCodeId === code._id;
                                                    return (
                                                        <li key={code._id}>
                                                            <div className="flex flex-col gap-3 py-3.5 pl-10 pr-5 sm:flex-row sm:items-center">
                                                                <RowCheckbox checked={bulk.isSelected(code._id)} onChange={() => bulk.toggle(code._id)} label={`Select ${code.code}`} />
                                                                <button
                                                                    type="button"
                                                                    onClick={() => openCode(code._id)}
                                                                    aria-expanded={codeOpen}
                                                                    className="min-w-0 flex-1 text-left"
                                                                >
                                                                    <span className="flex flex-wrap items-center gap-2">
                                                                        <span className="font-mono text-sm font-semibold text-white">{code.code}</span>
                                                                        <StatusBadge value={code.isActive ? 'active' : 'inactive'} />
                                                                        <StatusBadge
                                                                            tone={isAdminCode(code) ? 'accent' : 'info'}
                                                                            title={isAdminCode(code) ? 'Platform code — applies across events' : 'Created by the event owner'}
                                                                        >
                                                                            {isAdminCode(code) ? 'Admin (platform)' : 'Event owner'}
                                                                        </StatusBadge>
                                                                    </span>
                                                                    <span className="mt-1 block text-xs text-gray-400">
                                                                        {code.discountType === 'percentage' ? `${code.discountValue}% off` : `₹${code.discountValue} off`}
                                                                        {' · '}Uses: {code.usedCount}/{code.maxUses || '∞'}
                                                                    </span>
                                                                    <span className="mt-0.5 block text-xs text-gray-500">
                                                                        Valid: {formatDate(code.validFrom)} – {formatDate(code.validUntil)}
                                                                        {code.createdBy && ` · By: ${code.createdBy.name || code.createdBy.email || 'Unknown'}`}
                                                                    </span>
                                                                </button>
                                                                <div className="flex items-center gap-1">
                                                                    <Button
                                                                        size="sm"
                                                                        variant="secondary"
                                                                        onClick={() => toggleActive(code)}
                                                                        isLoading={toggling[code._id]}
                                                                        leftIcon={code.isActive ? <PowerOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Power className="h-3.5 w-3.5" aria-hidden="true" />}
                                                                    >
                                                                        {code.isActive ? 'Deactivate' : 'Activate'}
                                                                    </Button>
                                                                    <IconButton label={`Delete discount code ${code.code}`} tone="danger" icon={Trash2} onClick={() => remove(code)} />
                                                                    <ChevronDown className={cn('hidden h-4 w-4 text-gray-500 transition-transform sm:block', codeOpen && 'rotate-180')} aria-hidden="true" />
                                                                </div>
                                                            </div>

                                                            {/* Level 3: analytics */}
                                                            {codeOpen && (
                                                                <div className="pb-5 pl-10 pr-5">
                                                                    <CodeAnalytics entry={analytics[code._id]} />
                                                                </div>
                                                            )}
                                                        </li>
                                                    );
                                                })}
                                            </ul>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>

                        {/* Pagination over event groups */}
                        <Pagination currentPage={page} totalPages={totalPages} onChange={(p) => set({ page: p })} />
                    </>
                )}
            </Card>
        </div>
    );
}
