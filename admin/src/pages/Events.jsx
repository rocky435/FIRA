import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Ticket, Check, X, Ban, RotateCcw, Trash2, CircleCheck, Info, MapPin, CalendarClock, Tags } from 'lucide-react';
import adminApi from '../api/adminApi';
import { useListParams } from '../lib/useListParams';
import { useRemote } from '../lib/useRemote';
import { useBulkSelection } from '../lib/useBulkSelection';
import { useBulkRunner } from '../lib/useBulkRunner';
import { formatDateTime } from '../lib/formatDateTime';
import { eventActions, eventAwaitsAdmin, decideEvent, EVENT_DELETE_MESSAGE, useConfirmedAction } from '../lib/listingActions';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { FilterTabs } from '../components/ui/FilterTabs';
import { SearchInput } from '../components/ui/SearchInput';
import { Select } from '../components/ui/Select';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Table, THead, Th, TBody, Td } from '../components/ui/Table';
import { IconButton, RowCheckbox } from '../components/ui/IconButton';
import { Button } from '../components/ui/Button';
import { Pagination } from '../components/ui/Pagination';
import { EmptyState, ErrorState, TableSkeleton, Skeleton } from '../components/ui/States';
import { useConfirm } from '../components/ui/confirmContext';
import { useToast } from '../components/ui/toastContext';
import BulkActionBar from '../components/BulkActionBar';
import TicketTiers, { TierPriceRange } from '../components/TicketTiers';
import EventRejectDialog from '../components/EventRejectDialog';

const ITEMS_PER_PAGE = 10;
// Upcoming and ongoing are what an admin checks day to day, so they sit on the
// strip; the rest fold into "Others". These three follow the event's dates on
// the server (an approved event is "upcoming" until it starts).
const MAIN_STATUSES = [
    { value: 'all', label: 'All' },
    { value: 'upcoming', label: 'Upcoming' },
    { value: 'ongoing', label: 'Ongoing' },
];
const OTHER_STATUSES = [
    { value: 'completed', label: 'Completed' },
    { value: 'pending', label: 'Pending' },
    { value: 'cancelled', label: 'Cancelled' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'blocked', label: 'Blocked' },
];
const STATUSES = [...MAIN_STATUSES, ...OTHER_STATUSES].map((s) => s.value);

// What the row's badge says. Approval stores `approved`, and the lifecycle job
// only moves it on when it runs, so a live event is labelled from its dates.
function shownStatus(event, now = Date.now()) {
    if (!['approved', 'upcoming', 'ongoing'].includes(event.status)) return event.status;
    const start = new Date(event.startDateTime).getTime();
    const end = new Date(event.endDateTime).getTime();
    if (end <= now) return 'completed';
    if (start <= now) return 'ongoing';
    return 'upcoming';
}
const TYPES = [
    { value: 'all', label: 'Public and private' },
    { value: 'public', label: 'Public only' },
    { value: 'private', label: 'Private only' },
];

const venueName = (event) => (event.customVenue?.isCustom ? event.customVenue.name : event.venue?.name) || '—';
const venueCity = (event) => (event.customVenue?.isCustom ? event.customVenue.city : event.venue?.address?.city) || 'Unknown location';

// Tickets sold against capacity, e.g. "120 / 200". currentAttendees is the live
// counter: ticket sales add to it and refunds take it back down.
function TicketsSold({ event }) {
    const sold = event.currentAttendees || 0;
    const max = event.maxAttendees || 0;
    const pct = max > 0 ? Math.min(100, Math.round((sold / max) * 100)) : 0;
    return (
        <div className="min-w-[90px]">
            <p className="tabular-nums text-white">{sold.toLocaleString('en-IN')}<span className="text-gray-500"> / {max ? max.toLocaleString('en-IN') : '—'}</span></p>
            {max > 0 && (
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/[0.08]" aria-hidden="true">
                    <div className={`h-full rounded-full ${pct >= 100 ? 'bg-amber-400' : 'bg-violet-400'}`} style={{ width: `${pct}%` }} />
                </div>
            )}
        </div>
    );
}

function ApprovalSteps({ event }) {
    const step = (label, value) => (
        <StatusBadge value={value || 'pending'} className="w-fit">{label}: {value || 'pending'}</StatusBadge>
    );
    return (
        <div className="flex flex-col gap-1">
            {step('Venue', event.venueApproval?.status)}
            {step('Admin', event.adminApproval?.status)}
        </div>
    );
}

function PendingCard({ event, busy, onView, onApprove, onReject }) {
    return (
        <Card>
            <div className="flex flex-col justify-between gap-5 lg:flex-row">
                <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap items-center gap-1.5">
                        <StatusBadge tone="success" icon={Check}>Venue approved</StatusBadge>
                        <StatusBadge tone="warning">Waiting for admin</StatusBadge>
                    </div>
                    <h3 className="text-lg font-semibold text-white">{event.name}</h3>
                    <dl className="mt-4 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                        <div>
                            <dt className="mb-1 flex items-center gap-1.5 text-xs text-gray-400"><MapPin className="h-3.5 w-3.5" aria-hidden="true" />Venue</dt>
                            <dd className="text-white">{venueName(event)}</dd>
                            <dd className="text-xs text-gray-400">{venueCity(event)}</dd>
                        </div>
                        <div>
                            <dt className="mb-1 flex items-center gap-1.5 text-xs text-gray-400"><CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />Starts</dt>
                            <dd className="text-white">{formatDateTime(event.startDateTime)}</dd>
                        </div>
                        <div>
                            <dt className="mb-1 flex items-center gap-1.5 text-xs text-gray-400"><CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />Ends</dt>
                            <dd className="text-white">{formatDateTime(event.endDateTime)}</dd>
                        </div>
                        <div>
                            {/* Every category with its price and quantity - the approval
                                decision used to be made without seeing any price at all. */}
                            <dt className="mb-1 flex items-center gap-1.5 text-xs text-gray-400"><Tags className="h-3.5 w-3.5" aria-hidden="true" />Tickets · {(event.maxAttendees ?? 0).toLocaleString('en-IN')} total</dt>
                            <dd><TicketTiers event={event} compact /></dd>
                        </div>
                    </dl>
                    <p className="mt-4 border-t border-line pt-3 text-sm text-gray-400">
                        Organizer: <span className="text-white">{event.organizer?.name || '—'}</span>
                        {event.organizer?.email && <span> · {event.organizer.email}</span>}
                    </p>
                </div>
                <div className="flex flex-row justify-end gap-2 lg:flex-col">
                    <Button size="sm" variant="secondary" onClick={onView}>View details</Button>
                    <Button size="sm" variant="success" onClick={onApprove} isLoading={busy} leftIcon={<Check className="h-4 w-4" aria-hidden="true" />}>Approve</Button>
                    <Button size="sm" variant="danger" onClick={onReject} disabled={busy} leftIcon={<X className="h-4 w-4" aria-hidden="true" />}>Reject</Button>
                </div>
            </div>
        </Card>
    );
}

const loadPendingCount = () => adminApi.getPendingEventApprovals({ page: 1, limit: 1 });

export default function Events() {
    const navigate = useNavigate();
    const confirm = useConfirm();
    const toast = useToast();
    const runAction = useConfirmedAction();
    // ?tab=pending opens the approvals queue (the dashboard links here that way).
    const { params, set } = useListParams({ tab: 'all', status: 'all', type: 'all', q: '', page: 1 });
    const tab = params.tab === 'pending' ? 'pending' : 'all';
    const status = STATUSES.includes(params.status) ? params.status : 'all';
    const type = TYPES.some((t) => t.value === params.type) ? params.type : 'all';

    const loadList = useCallback(() => {
        if (tab === 'pending') {
            return adminApi.getPendingEventApprovals({ page: params.page, limit: ITEMS_PER_PAGE }).then((d) => ({ ...d, tab }));
        }
        // No includeCompleted flag: that is a param of the *public* /api/events
        // route. The admin listing is /api/admin/events, which has no status
        // allow-list at all, so `status: 'completed'` is enough here.
        const query = { page: params.page, limit: ITEMS_PER_PAGE };
        if (status !== 'all') query.status = status;
        if (type !== 'all') query.eventType = type;
        if (params.q) query.search = params.q;
        return adminApi.getEvents(query).then((d) => ({ ...d, tab }));
    }, [tab, status, type, params.page, params.q]);
    const remote = useRemote(loadList);
    const { error, reload } = remote;
    // Each answer is tagged with its tab: just after switching, the other tab's
    // rows are still held, and must not be drawn in this tab's layout.
    const sameTab = remote.data?.tab === tab;
    const data = sameTab ? remote.data : undefined;
    const loading = remote.loading || (!sameTab && !error);
    const refreshing = sameTab && remote.refreshing;
    // The queue's size for the tab badge, whichever tab is open. (It used to
    // read the pending list, which was only loaded on the pending tab, so on
    // "All events" the badge never showed.)
    const { data: pendingData, reload: reloadPending } = useRemote(loadPendingCount);

    const events = data?.events || [];
    const totalPages = data?.totalPages || 1;
    const total = data?.total || 0;
    const pendingTotal = pendingData?.total || 0;

    const [processingId, setProcessingId] = useState(null);
    const [rejecting, setRejecting] = useState(null);
    const bulk = useBulkSelection();
    const pageIds = events.map((e) => e._id);
    const refresh = () => { reload(); reloadPending(); };

    const approve = async (event) => {
        const ok = await confirm({ title: `Approve "${event.name}"?`, message: 'It will go live immediately.', confirmLabel: 'Approve event' });
        if (!ok) return;
        setProcessingId(event._id);
        try {
            await decideEvent(event._id, 'approved');
            toast.success(`"${event.name}" is approved`);
            refresh();
        } catch (err) {
            toast.error(err?.message || 'Failed to update event status');
        } finally {
            setProcessingId(null);
        }
    };

    const reject = async (reason) => {
        const event = rejecting;
        setProcessingId(event._id);
        try {
            await decideEvent(event._id, 'rejected', reason);
            setRejecting(null);
            toast.success(`"${event.name}" is rejected`);
            refresh();
        } catch (err) {
            toast.error(err?.message || 'Failed to update event status');
        } finally {
            setProcessingId(null);
        }
    };

    const block = async (event) => { if (await runAction(eventActions(event).block)) refresh(); };
    const unblock = async (event) => { if (await runAction(eventActions(event).unblock)) refresh(); };
    const remove = async (event) => { if (await runAction(eventActions(event).remove)) refresh(); };

    const { busy: bulkBusy, run } = useBulkRunner({ bulk, reload: refresh, noun: ['event', 'events'] });
    const bulkActions = [
        // Called directly: it used to go through the single-row approve, which
        // asked to confirm again for every selected event.
        { label: 'Approve', onClick: () => run({ verb: 'Approve', past: 'Approved', message: 'They will go live immediately.', fn: (id) => decideEvent(id, 'approved') }) },
        { label: 'Block', variant: 'danger', onClick: () => run({ verb: 'Block', past: 'Blocked', danger: true, fn: (id) => adminApi.updateEventStatus(id, 'blocked') }) },
        { label: 'Delete', variant: 'danger', onClick: () => run({ verb: 'Delete', past: 'Deleted', danger: true, message: EVENT_DELETE_MESSAGE, requireText: 'DELETE', fn: (id) => adminApi.deleteEvent(id) }) },
    ];

    const filtered = params.q || status !== 'all' || type !== 'all';

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader title="Events" description="Manage and approve event listings" count={loading || tab === 'pending' ? null : total} />

            <div className="mb-5">
                <FilterTabs
                    label="Event view"
                    value={tab}
                    onChange={(v) => { bulk.clear(); set({ tab: v }); }}
                    options={[
                        { value: 'all', label: 'All events' },
                        { value: 'pending', label: 'Pending approvals', count: pendingTotal },
                    ]}
                />
            </div>

            {tab === 'pending' ? (
                <div className="space-y-4">
                    <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-4 text-sm">
                        <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
                        <p className="text-amber-100/80">
                            These events have been approved by their venue owners and are waiting for your final approval to go live.
                        </p>
                    </div>

                    {error ? (
                        <Card><ErrorState title="Couldn't load pending events" message={error} onRetry={reload} /></Card>
                    ) : loading ? (
                        <div className="space-y-4" role="status" aria-label="Loading">
                            {[0, 1].map((i) => <Skeleton key={i} className="h-44 rounded-2xl" />)}
                        </div>
                    ) : events.length === 0 ? (
                        <Card>
                            <EmptyState icon={CircleCheck} title="All caught up" message="No events are waiting for approval." />
                        </Card>
                    ) : (
                        <div className={`space-y-4 transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
                            {events.map((event) => (
                                <PendingCard
                                    key={event._id}
                                    event={event}
                                    busy={processingId === event._id}
                                    onView={() => navigate(`/events/${event._id}`)}
                                    onApprove={() => approve(event)}
                                    onReject={() => setRejecting(event)}
                                />
                            ))}
                            <Card padded={false}>
                                <Pagination currentPage={params.page} totalPages={totalPages} onChange={(page) => set({ page })} className="border-t-0" />
                            </Card>
                        </div>
                    )}
                </div>
            ) : (
                <>
                    <div className="mb-4 flex flex-col gap-3">
                        <FilterTabs label="Event status" options={MAIN_STATUSES} more={OTHER_STATUSES} value={status} onChange={(v) => set({ status: v })} />
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                            <div className="sm:w-52">
                                <Select aria-label="Event type" value={type} onChange={(e) => set({ type: e.target.value })} options={TYPES} />
                            </div>
                            <SearchInput value={params.q} onSearch={(q) => set({ q })} placeholder="Search name, venue or city" label="Search events" />
                        </div>
                    </div>

                    <BulkActionBar count={bulk.count} actions={bulkActions} onClear={bulk.clear} busy={bulkBusy} />

                    <Card padded={false} aria-busy={loading || refreshing || undefined} className={`overflow-hidden transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
                        {error ? (
                            <ErrorState title="Couldn't load events" message={error} onRetry={reload} />
                        ) : loading ? (
                            <TableSkeleton rows={6} columns={7} />
                        ) : events.length === 0 ? (
                            <EmptyState
                                icon={Ticket}
                                title={filtered ? (status !== 'all' ? `No ${status} events found` : 'No events match these filters') : 'No events yet'}
                                message={params.q ? `Nothing found for "${params.q}".` : undefined}
                            />
                        ) : (
                            <Table label="Events">
                                <THead>
                                    <Th className="w-10">
                                        <RowCheckbox checked={bulk.isPageAllSelected(pageIds)} onChange={() => bulk.togglePage(pageIds)} label="Select all on this page" />
                                    </Th>
                                    <Th>Event</Th>
                                    <Th>Organizer</Th>
                                    <Th>Venue</Th>
                                    <Th>Date</Th>
                                    <Th>Price</Th>
                                    <Th>Tickets sold</Th>
                                    <Th>Approvals</Th>
                                    <Th>Status</Th>
                                    <Th className="text-right">Actions</Th>
                                </THead>
                                <TBody>
                                    {events.map((event) => (
                                        <tr
                                            key={event._id}
                                            onClick={() => navigate(`/events/${event._id}`)}
                                            className={`cursor-pointer ${bulk.isSelected(event._id) ? 'bg-violet-500/[0.06]' : ''}`}
                                        >
                                            <Td onClick={(e) => e.stopPropagation()}>
                                                <RowCheckbox checked={bulk.isSelected(event._id)} onChange={() => bulk.toggle(event._id)} label={`Select ${event.name}`} />
                                            </Td>
                                            <Td>
                                                <div className="flex items-center gap-3">
                                                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-300">
                                                        <Ticket className="h-4 w-4" aria-hidden="true" />
                                                    </span>
                                                    <div className="min-w-0">
                                                        <p className="font-medium text-white">{event.name}</p>
                                                        <div className="mt-1 flex flex-wrap gap-1">
                                                            {event.eventType === 'private' && <StatusBadge value="private" />}
                                                            {event.deletionRequest?.requestedAt && (
                                                                <StatusBadge tone="danger" title={event.deletionRequest.reason || 'The organizer asked for this event to be removed'}>
                                                                    Removal requested
                                                                </StatusBadge>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </Td>
                                            <Td>
                                                <p className="text-white">{event.organizer?.name || '—'}</p>
                                                <p className="text-xs text-gray-400">{event.organizer?.email}</p>
                                            </Td>
                                            <Td>
                                                <p>{venueName(event)}</p>
                                                <p className="text-xs text-gray-400">{venueCity(event)}</p>
                                            </Td>
                                            <Td>{formatDateTime(event.startDateTime)}</Td>
                                            <Td><TierPriceRange event={event} className="tabular-nums" /></Td>
                                            <Td><TicketsSold event={event} /></Td>
                                            <Td><ApprovalSteps event={event} /></Td>
                                            <Td><StatusBadge value={shownStatus(event)} /></Td>
                                            <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                                                <div className="flex items-center justify-end gap-1">
                                                    {eventAwaitsAdmin(event) && (
                                                        <>
                                                            <IconButton label={`Approve ${event.name}`} tone="success" icon={Check} disabled={processingId === event._id} onClick={() => approve(event)} />
                                                            <IconButton label={`Reject ${event.name}`} tone="warning" icon={X} disabled={processingId === event._id} onClick={() => setRejecting(event)} />
                                                        </>
                                                    )}
                                                    {event.status === 'approved' && (
                                                        <IconButton label={`Block ${event.name}`} tone="danger" icon={Ban} onClick={() => block(event)} />
                                                    )}
                                                    {event.status === 'blocked' && (
                                                        <IconButton label={`Unblock ${event.name}`} tone="success" icon={RotateCcw} onClick={() => unblock(event)} />
                                                    )}
                                                    <IconButton label={`Delete event ${event.name}`} tone="danger" icon={Trash2} onClick={() => remove(event)} />
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
                </>
            )}

            {/* Keyed so each opening starts with an empty reason box. */}
            <EventRejectDialog
                key={rejecting?._id || 'closed'}
                event={rejecting}
                busy={Boolean(rejecting) && processingId === rejecting._id}
                onCancel={() => setRejecting(null)}
                onReject={reject}
            />
        </div>
    );
}
