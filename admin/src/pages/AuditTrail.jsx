import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import adminApi from '../api/adminApi';
import Dropdown from '../components/ui/Dropdown';
import { Pagination } from '../components/ui/Pagination';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Table, THead, Th, TBody, Td } from '../components/ui/Table';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorState, TableSkeleton } from '../components/ui/States';
import { formatInr } from '../lib/formatInr';
import { formatDateTime } from '../lib/formatDateTime';
import { useListParams } from '../lib/useListParams';
import { useRemote } from '../lib/useRemote';
import { humanize } from '../lib/statusStyles';

const ITEMS_PER_PAGE = 20;

const ENTITY_TYPE_OPTIONS = [
    { value: '', label: 'All Entity Types' },
    { value: 'event', label: 'Event' },
    { value: 'venue', label: 'Venue' },
    { value: 'creator', label: 'Creator' },
    { value: 'user', label: 'User' },
    { value: 'refund', label: 'Refund' },
    { value: 'ticket', label: 'Ticket sale' },
];

const ACTION_OPTIONS = [
    { value: '', label: 'All Actions' },
    { value: 'approve', label: 'Approve' },
    { value: 'reject', label: 'Reject' },
    { value: 'block', label: 'Block' },
    { value: 'unblock', label: 'Unblock' },
    { value: 'feature', label: 'Feature' },
    { value: 'unfeature', label: 'Unfeature' },
    { value: 'sale', label: 'Ticket sale' },
    { value: 'settle', label: 'Settle' },
    { value: 'reverse', label: 'Reverse settlement' },
    { value: 'delete', label: 'Delete' },
    { value: 'update', label: 'Other change' },
];

/*
 * Absolute time plus a relative one.
 *
 * "2 hours ago" is what answers "is this recent?" at a glance, but on its own it is
 * useless for reconciling against anything, so both are shown - the exact stamp
 * (formatDateTime) as the value and the relative one underneath.
 */
const formatRelative = (ts) => {
    const dt = new Date(ts);
    if (!ts || isNaN(dt.getTime())) return '';
    const secs = Math.round((Date.now() - dt.getTime()) / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 31) return `${days}d ago`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.round(months / 12)}y ago`;
};

/** Where an entry's subject can be opened in the dashboard, if anywhere. */
const ENTITY_PATH = { event: '/events', venue: '/venues', creator: '/brands', user: '/users' };

const shortId = (id) => (id ? String(id).slice(-8) : '—');

const describeValue = (v) => {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    if (v === null || v === undefined || v === '') return '—';
    return String(v);
};

/**
 * What changed, in words.
 *
 * The table used to show only action / entity type / entity id, so reviewing a
 * decision meant copying a 24-character id into another screen and guessing what the
 * previous state had been. The from/to now recorded on every entry is the part that
 * makes the trail reviewable rather than merely present.
 */
// Stored field names, as the admin reads them.
const FIELD_LABEL = { adminApproval: 'Admin approval', isFeatured: 'Featured', status: 'Status' };

function ChangeDetail({ log }) {
    const meta = log.metadata || {};
    const hasTransition = meta.field && (meta.from !== undefined || meta.to !== undefined);
    // Money movement records the listing under listingName, and the amount is the
    // whole point of the row - a settlement without its figure is unreviewable
    // (Requirement 8.5). A reversal's settledAmount is negative, and formatInr
    // renders the sign, which is what tells the two rows apart at a glance.
    const isSettlement = log.action === 'settle' || log.action === 'reverse';
    const isSale = log.action === 'sale';

    return (
        <div className="min-w-0">
            <div className="truncate text-sm text-white">
                {meta.name || meta.listingName || <span className="text-gray-500">Unnamed {log.entityType}</span>}
            </div>
            {isSettlement && (
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className={log.action === 'reverse' ? 'text-amber-300' : 'text-emerald-300'}>
                        {formatInr(meta.settledAmount)}
                    </span>
                    {meta.settlementReference && (
                        <span className="truncate font-mono text-gray-400">{meta.settlementReference}</span>
                    )}
                </div>
            )}
            {isSale && (
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-sky-300">{formatInr(meta.amountPaid)}</span>
                    <span className="text-gray-400">{meta.quantity} × {meta.tier}</span>
                    {meta.ticketId && <span className="truncate font-mono text-gray-500">{meta.ticketId}</span>}
                </div>
            )}
            {hasTransition && (
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-400">
                    <span className="text-gray-500">{FIELD_LABEL[meta.field] || meta.field}</span>
                    <span className="line-through">{describeValue(meta.from)}</span>
                    <span aria-hidden="true">→</span>
                    <span className="text-gray-200">{describeValue(meta.to)}</span>
                </div>
            )}
            {/* Event approvals: the reason sent to the organiser, or whether it went live. */}
            {typeof meta.reason === 'string' && meta.reason && (
                <div className="mt-0.5 text-xs text-gray-400">Reason: <span className="text-gray-200">{meta.reason}</span></div>
            )}
            {log.entityType === 'event' && log.action === 'approve' && typeof meta.wentLive === 'boolean' && (
                <div className="mt-0.5 text-xs text-gray-400">
                    {meta.wentLive ? 'Went live' : 'Waiting for the venue to approve or be paid'}
                </div>
            )}
            {meta.badgeChanged && (
                <div className="mt-0.5 text-xs text-violet-300">
                    Verified badge {meta.to === 'approved' ? 'granted' : 'removed'}
                </div>
            )}
            {meta.email && !hasTransition && (
                <div className="mt-0.5 truncate text-xs text-gray-400">{meta.email}</div>
            )}
        </div>
    );
}

export default function AuditTrail() {
    // Filters and page live in the URL, so Back and refresh keep your place.
    const { params, set } = useListParams({ entity: '', action: '', page: 1 });
    const load = useCallback(() => {
        const query = { page: params.page, limit: ITEMS_PER_PAGE };
        if (params.entity) query.entityType = params.entity;
        if (params.action) query.action = params.action;
        return adminApi.getAuditTrail(query);
    }, [params.page, params.entity, params.action]);
    const { data, loading, refreshing, error, reload } = useRemote(load);
    const logs = data?.entries || data?.logs || [];
    const totalPages = data?.pages || data?.totalPages || 1;
    const total = data?.total || 0;
    const currentPage = params.page;

    // The trail is permanent: entries cannot be deleted or cleared from here or
    // the API, so it stays a reliable record of every admin action.

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader
                title="Audit Trail"
                // "Page X of Y" also sits beside the pager; it stays up here too so it
                // is visible without scrolling to the bottom of a long page.
                description={totalPages > 1 ? `Admin actions and ticket sales · Page ${currentPage} of ${totalPages}` : 'Admin actions and ticket sales'}
                count={loading ? null : total}
            />

            {/* Filters. Fixed-width on desktop so two short dropdowns don't stretch
                the full page width; full-width stacked below sm. */}
            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:max-w-xl">
                <Dropdown
                    value={params.entity}
                    onChange={(e) => set({ entity: e.target.value })}
                    options={ENTITY_TYPE_OPTIONS}
                    label="Entity type"
                />
                <Dropdown
                    value={params.action}
                    onChange={(e) => set({ action: e.target.value })}
                    options={ACTION_OPTIONS}
                    label="Action"
                />
            </div>

            <Card padded={false} aria-busy={loading || refreshing || undefined} className={`overflow-hidden transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
                {error ? (
                    <ErrorState title="Couldn't load the audit trail" message={error} onRetry={reload} />
                ) : loading ? (
                    <TableSkeleton rows={8} columns={4} />
                ) : logs.length === 0 ? (
                    <EmptyState
                        icon={ClipboardList}
                        title={params.entity || params.action ? 'No entries match these filters' : 'No audit entries yet'}
                        // The pager hides itself at a single page, so a stale page
                        // number would otherwise leave an empty table with no way back.
                        action={totalPages <= 1 && currentPage > 1 ? (
                            <Button size="sm" variant="secondary" onClick={() => set({ page: 1 })}>Back to first page</Button>
                        ) : undefined}
                    />
                ) : (
                    <Table label="Audit trail">
                        <THead>
                            <Th>Action</Th>
                            <Th>What changed</Th>
                            <Th>By</Th>
                            <Th>When</Th>
                        </THead>
                        <TBody>
                            {logs.map((log) => (
                                <tr key={log._id} className="align-top">
                                    <Td className="whitespace-nowrap align-top">
                                        <StatusBadge value={log.action}>{humanize(log.action)}</StatusBadge>
                                        <div className="mt-1 text-xs capitalize text-gray-400">{log.entityType}</div>
                                    </Td>
                                    <Td className="max-w-xs align-top">
                                        <ChangeDetail log={log} />
                                        {/* Last 8 characters, not all 24. The full id made every
                                            row the same width as its longest column and pushed the
                                            timestamp off screen; the tail is enough to tell two
                                            entries apart, and the link is the way through. */}
                                        {ENTITY_PATH[log.entityType] && log.action !== 'delete' ? (
                                            <Link
                                                to={`${ENTITY_PATH[log.entityType]}/${log.entityId}`}
                                                title={String(log.entityId)}
                                                className="mt-1 inline-block font-mono text-xs text-violet-300 hover:text-violet-200"
                                            >
                                                …{shortId(log.entityId)}
                                            </Link>
                                        ) : (
                                            <span className="mt-1 inline-block font-mono text-xs text-gray-500" title={String(log.entityId)}>
                                                …{shortId(log.entityId)}
                                            </span>
                                        )}
                                    </Td>
                                    <Td className="align-top">
                                        <div className="text-sm text-white">{log.adminUser?.name || 'Unknown'}</div>
                                        {log.adminUser?.email && (
                                            <div className="mt-0.5 text-xs text-gray-400">{log.adminUser.email}</div>
                                        )}
                                    </Td>
                                    <Td className="whitespace-nowrap align-top">
                                        <div className="text-sm text-gray-300">{formatDateTime(log.timestamp)}</div>
                                        <div className="mt-0.5 text-xs text-gray-500">{formatRelative(log.timestamp)}</div>
                                    </Td>
                                </tr>
                            ))}
                        </TBody>
                    </Table>
                )}

                {/* Numbered pages, not just Previous/Next: this is the one screen
                    whose whole purpose is looking back. */}
                {!loading && !error && (
                    <Pagination currentPage={currentPage} totalPages={totalPages} onChange={(page) => set({ page })} />
                )}
            </Card>
        </div>
    );
}
