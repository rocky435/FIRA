import { useCallback, useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
    Ticket, IndianRupee, Tags, Users as UsersIcon, CalendarClock, ExternalLink, Check, X, Ban, RotateCcw, Trash2,
    Star, TriangleAlert, Lock, UserCheck,
} from 'lucide-react';
import adminApi from '../api/adminApi';
import { formatInr } from '../lib/formatInr';
import { formatDateTime } from '../lib/formatDateTime';
import { useRemote } from '../lib/useRemote';
import { useListParams } from '../lib/useListParams';
import { humanize } from '../lib/statusStyles';
import { eventTiers, tierTotals } from '../lib/ticketTiers';
import { eventActions, eventAwaitsAdmin, decideEvent, useConfirmedAction } from '../lib/listingActions';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { StatCard } from '../components/ui/StatCard';
import { StatusBadge } from '../components/ui/StatusBadge';
import { InfoList } from '../components/ui/InfoList';
import { Button } from '../components/ui/Button';
import { SearchInput } from '../components/ui/SearchInput';
import { Table, THead, Th, TBody, Td } from '../components/ui/Table';
import { Pagination } from '../components/ui/Pagination';
import { EmptyState, ErrorState, PageSkeleton } from '../components/ui/States';
import { useConfirm } from '../components/ui/confirmContext';
import { useToast } from '../components/ui/toastContext';
import TicketTiers, { TierPriceRange } from '../components/TicketTiers';
import BankDetails from '../components/BankDetails';
import EventRejectDialog from '../components/EventRejectDialog';
import ListingSettlementPanel from '../components/ListingSettlementPanel';

const BUYERS_PER_PAGE = 10;

const formatDate = (value) => {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

function ApprovalStep({ label, approval }) {
    const status = approval?.status || 'pending';
    return (
        <div className="rounded-xl border border-line bg-surface-raised p-3.5">
            <p className="text-xs text-gray-400">{label}</p>
            <StatusBadge value={status} className="mt-2" />
            {approval?.respondedAt && <p className="mt-2 text-xs text-gray-500">{formatDateTime(approval.respondedAt)}</p>}
            {status === 'rejected' && approval?.rejectionReason && (
                <p className="mt-2 text-xs text-red-200/90">Reason: {approval.rejectionReason}</p>
            )}
        </div>
    );
}

export default function EventDetail() {
    const { id } = useParams();
    const navigate = useNavigate();
    const confirm = useConfirm();
    const toast = useToast();
    const runAction = useConfirmedAction();
    const loadEvent = useCallback(() => adminApi.getEventById(id), [id]);
    const { data: event, loading, refreshing, error, reload } = useRemote(loadEvent);
    const { params, set } = useListParams({ q: '', page: 1 });
    const [featuredBusy, setFeaturedBusy] = useState(false);
    const [rejecting, setRejecting] = useState(false);
    const [rejectBusy, setRejectBusy] = useState(false);

    const tickets = useMemo(() => event?.tickets || [], [event]);
    const filteredTickets = useMemo(() => {
        const q = params.q.toLowerCase();
        if (!q) return tickets;
        return tickets.filter((t) =>
            t.user?.name?.toLowerCase().includes(q)
            || t.user?.email?.toLowerCase().includes(q)
            || t.ticketType?.toLowerCase().includes(q)
            || t.ticketId?.toLowerCase().includes(q));
    }, [tickets, params.q]);

    if (loading && !error) return <PageSkeleton />;
    if (event && event._id !== id && !error) return <PageSkeleton />;
    if (error || !event) {
        return (
            <div className="p-4 sm:p-6 lg:p-8">
                <PageHeader title="Event" backTo="/events" backLabel="Back to events" />
                <Card>
                    <ErrorState title={error ? "Couldn't load this event" : 'Event not found'} message={error || 'It may have been deleted.'} onRetry={error ? reload : undefined} />
                </Card>
            </div>
        );
    }

    const stats = event.stats || {};
    const tiers = eventTiers(event);
    const totals = tierTotals(tiers);
    const sold = stats.ticketsSold ?? event.currentAttendees ?? 0;
    const capacity = event.maxAttendees || totals.quantity || 0;
    const soldPct = capacity > 0 ? Math.min(100, Math.round((sold / capacity) * 100)) : 0;
    const actions = eventActions(event);
    const awaits = eventAwaitsAdmin(event);
    const canFeature = ['approved', 'upcoming'].includes(event.status);
    const organizer = event.organizer || {};
    const custom = event.customVenue?.isCustom ? event.customVenue : null;

    const totalPages = Math.max(1, Math.ceil(filteredTickets.length / BUYERS_PER_PAGE));
    const page = Math.min(params.page, totalPages);
    const pageTickets = filteredTickets.slice((page - 1) * BUYERS_PER_PAGE, page * BUYERS_PER_PAGE);

    const act = async (key) => {
        if (await runAction(actions[key])) {
            if (key === 'remove') navigate('/events');
            else reload();
        }
    };

    const reject = async (reason) => {
        setRejectBusy(true);
        try {
            await decideEvent(event._id, 'rejected', reason);
            setRejecting(false);
            toast.success(`"${event.name}" is rejected`);
            reload();
        } catch (err) {
            toast.error(err?.message || 'Failed to update event status');
        } finally {
            setRejectBusy(false);
        }
    };

    const toggleFeatured = async () => {
        const next = !event.isFeatured;
        const ok = await confirm(next
            ? { title: `Feature "${event.name}"?`, message: 'It will appear at the top of listings.', confirmLabel: 'Feature event' }
            : { title: `Remove "${event.name}" from featured?`, confirmLabel: 'Remove from featured' });
        if (!ok) return;
        setFeaturedBusy(true);
        try {
            await adminApi.toggleFeatured(event._id, next);
            toast.success(next ? `"${event.name}" is featured` : `"${event.name}" is no longer featured`);
            reload();
        } catch (err) {
            toast.error(err?.message || 'Failed to update featured status');
        } finally {
            setFeaturedBusy(false);
        }
    };

    return (
        <div className={`p-4 sm:p-6 lg:p-8 transition-opacity ${refreshing ? 'opacity-70' : ''}`}>
            <PageHeader
                title={event.name}
                backTo="/events"
                backLabel="Back to events"
                actions={(
                    <>
                        <Button
                            variant="secondary"
                            onClick={toggleFeatured}
                            disabled={!canFeature}
                            isLoading={featuredBusy}
                            title={canFeature ? undefined : 'Only approved or upcoming events can be featured'}
                            leftIcon={<Star className={`h-4 w-4 ${event.isFeatured ? 'fill-amber-300 text-amber-300' : ''}`} aria-hidden="true" />}
                        >
                            {event.isFeatured ? 'Featured' : 'Feature'}
                        </Button>
                        {awaits && <Button variant="success" onClick={() => act('approve')} leftIcon={<Check className="h-4 w-4" aria-hidden="true" />}>Approve</Button>}
                        {awaits && <Button variant="secondary" onClick={() => setRejecting(true)} leftIcon={<X className="h-4 w-4" aria-hidden="true" />}>Reject</Button>}
                        {event.status === 'approved' && <Button variant="secondary" onClick={() => act('block')} leftIcon={<Ban className="h-4 w-4" aria-hidden="true" />}>Block</Button>}
                        {event.status === 'blocked' && <Button variant="success" onClick={() => act('unblock')} leftIcon={<RotateCcw className="h-4 w-4" aria-hidden="true" />}>Unblock</Button>}
                        <Button variant="danger" onClick={() => act('remove')} leftIcon={<Trash2 className="h-4 w-4" aria-hidden="true" />}>Delete</Button>
                    </>
                )}
            >
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <StatusBadge value={event.status} />
                    {event.eventType === 'private' && <StatusBadge value="private" icon={Lock}>Private{event.privateCode ? ` · code ${event.privateCode}` : ''}</StatusBadge>}
                    {event.category && <StatusBadge tone="neutral">{humanize(event.category)}</StatusBadge>}
                    {event.isFeatured && <StatusBadge tone="warning" icon={Star}>Featured</StatusBadge>}
                    <span className="ml-1 inline-flex items-center gap-1 text-sm text-gray-400">
                        <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                        {formatDateTime(event.startDateTime)} to {formatDateTime(event.endDateTime)}
                    </span>
                </div>
            </PageHeader>

            {event.status === 'blocked' && (
                <div role="note" className="mb-6 flex items-start gap-3 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-4 text-sm">
                    <Ban className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden="true" />
                    <p className="text-red-100/90">Blocked by FIRA and hidden from the site. Only an admin can unblock it; the organizer was told to contact FIRA.</p>
                </div>
            )}

            {event.deletionRequest?.requestedAt && (
                <div role="note" className="mb-6 flex items-start gap-3 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-4 text-sm">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden="true" />
                    <div>
                        <p className="font-medium text-red-200">The organizer asked for this event to be removed{formatDate(event.deletionRequest.requestedAt) ? ` on ${formatDate(event.deletionRequest.requestedAt)}` : ''}.</p>
                        {event.deletionRequest.reason && <p className="mt-1 text-red-100/80">Reason: {event.deletionRequest.reason}</p>}
                        <p className="mt-1 text-gray-400">Deleting cancels the tickets sold and adds their refunds to Refunds.</p>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
                <StatCard label="Tickets sold" value={sold.toLocaleString('en-IN')} icon={Ticket} accent="blue" hint={`${soldPct}% of ${capacity.toLocaleString('en-IN')}`}>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]" aria-hidden="true">
                        <div className={`h-full rounded-full ${soldPct >= 100 ? 'bg-amber-400' : 'bg-blue-400'}`} style={{ width: `${soldPct}%` }} />
                    </div>
                </StatCard>
                {/* Σ ticket prices, so before discounts, fee and GST - the
                    Settlement panel below breaks down what buyers paid. */}
                <StatCard label="Ticket sales" value={formatInr(stats.totalRevenue || 0)} icon={IndianRupee} accent="green" hint="Full price, before discounts" />
                <StatCard label="Ticket price" value={<TierPriceRange event={event} />} icon={Tags} accent="violet" hint={totals.count > 1 ? 'Every category below' : (event.ticketType === 'free' ? 'Free event' : 'One category')} />
                <StatCard label="Orders" value={(stats.totalBookings ?? tickets.length).toLocaleString('en-IN')} icon={UsersIcon} accent="amber" hint="Purchases, any size" />
            </div>

            {/* Every category, not just the first: event.ticketPrice only holds the
                first tier's price, so it cannot describe a multi-category event. */}
            <Card className="mt-6" title="Ticket categories" description={`${totals.count} ${totals.count === 1 ? 'category' : 'categories'} · ${totals.sold.toLocaleString('en-IN')} of ${totals.quantity.toLocaleString('en-IN')} sold`} padded={false}>
                <div className="border-t border-line">
                    <TicketTiers event={event} />
                </div>
            </Card>

            <div className="mt-6 grid gap-6 lg:grid-cols-3">
                <div className="space-y-6 lg:col-span-2">
                    {event.coverPhoto && (
                        <a href={event.coverPhoto} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-2xl border border-line">
                            <img src={event.coverPhoto} alt={`${event.name} cover`} loading="lazy" className="max-h-72 w-full object-cover" />
                        </a>
                    )}
                    <Card title="Event details">
                        <InfoList
                            items={[
                                { label: 'Description', value: event.description, wide: true },
                                {
                                    label: 'Venue',
                                    value: custom ? `${custom.name || 'Custom venue'} (own venue)` : (event.venue?._id
                                        ? <Link to={`/venues/${event.venue._id}`} className="hover:text-violet-300">{event.venue.name}</Link>
                                        : (event.venue?.name || '—')),
                                },
                                { label: 'City', value: custom ? custom.city : event.venue?.address?.city },
                                { label: 'Address', value: custom ? [custom.address, custom.city, custom.state, custom.pincode].filter(Boolean).join(', ') : null, wide: true },
                                {
                                    label: 'Map',
                                    value: custom?.locationLink ? (
                                        <a href={custom.locationLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-violet-300 hover:text-violet-200">
                                            Open in maps <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                                        </a>
                                    ) : null,
                                },
                                { label: 'Starts', value: formatDateTime(event.startDateTime) },
                                { label: 'Ends', value: formatDateTime(event.endDateTime) },
                                { label: 'Visibility', value: event.eventType === 'private' ? `Private${event.privateCode ? ` (code ${event.privateCode})` : ''}` : 'Public' },
                                { label: 'Tickets', value: event.ticketType === 'free' ? 'Free' : 'Paid' },
                                { label: 'Capacity', value: capacity ? `${capacity.toLocaleString('en-IN')} people` : null },
                                { label: 'Alcohol', value: event.allowAlcohol ? 'Allowed' : 'Not allowed' },
                                { label: 'Platform fee', value: event.platformFeePercentage != null ? `${event.platformFeePercentage}%` : null },
                                { label: 'Created', value: formatDate(event.createdAt) },
                                { label: 'Tags', value: event.tags?.length ? event.tags.join(', ') : null, wide: true },
                                { label: 'Terms', value: event.termsAndConditions, wide: true },
                            ]}
                        />
                    </Card>
                </div>

                <div className="space-y-6">
                    <Card title="Approvals">
                        <div className="grid gap-3">
                            <ApprovalStep label="Venue owner" approval={event.venueApproval} />
                            <ApprovalStep label="Admin" approval={event.adminApproval} />
                        </div>
                    </Card>

                    <Card title="Organizer">
                        <InfoList
                            className="sm:grid-cols-1"
                            items={[
                                { label: 'Name', value: organizer._id ? <Link to={`/users/${organizer._id}`} className="hover:text-violet-300">{organizer.name || 'Unnamed'}</Link> : (organizer.name || '—') },
                                { label: 'Email', value: organizer.email || '—' },
                                { label: 'Phone', value: organizer.phone || '—' },
                            ]}
                        />
                        {/* Sent by the server all along (admin-only read), never shown. */}
                        <div className="mt-4">
                            <BankDetails bank={organizer.bankDetails} />
                        </div>
                    </Card>
                </div>
            </div>

            <Card
                className="mt-6"
                title="Ticket buyers"
                description={`${tickets.length.toLocaleString('en-IN')} ${tickets.length === 1 ? 'order' : 'orders'}`}
                actions={<SearchInput value={params.q} onSearch={(q) => set({ q })} placeholder="Name, email, category or ticket ID" label="Search ticket buyers" />}
                padded={false}
            >
                {filteredTickets.length === 0 ? (
                    <div className="border-t border-line">
                        <EmptyState icon={Ticket} title={params.q ? 'No buyers match this search' : 'No tickets sold yet'} />
                    </div>
                ) : (
                    <div className="border-t border-line">
                        <Table label="Ticket buyers">
                            <THead>
                                <Th>Buyer</Th>
                                <Th>Phone</Th>
                                <Th>Category</Th>
                                <Th>Qty</Th>
                                <Th>Amount</Th>
                                <Th>Bought</Th>
                                <Th>Status</Th>
                                <Th>Checked in</Th>
                            </THead>
                            <TBody>
                                {pageTickets.map((t) => (
                                    <tr key={t._id}>
                                        <Td>
                                            <p className="font-medium text-white">{t.user?.name || 'Deleted account'}</p>
                                            <p className="text-xs text-gray-400">{t.user?.email}</p>
                                        </Td>
                                        <Td>{t.user?.phone || '—'}</Td>
                                        <Td>{t.ticketType ? humanize(t.ticketType) : '—'}</Td>
                                        <Td className="tabular-nums">{t.quantity || 1}</Td>
                                        <Td className="tabular-nums text-white">{formatInr(t.price || 0)}</Td>
                                        <Td>{formatDate(t.purchaseDate || t.createdAt) || '—'}</Td>
                                        <Td><StatusBadge value={t.status || 'active'} /></Td>
                                        <Td>
                                            {t.isUsed
                                                ? <span className="inline-flex items-center gap-1 text-xs text-green-400"><UserCheck className="h-4 w-4" aria-hidden="true" />{formatDateTime(t.usedAt) !== 'N/A' ? formatDateTime(t.usedAt) : 'Yes'}</span>
                                                : <span className="text-gray-500">—</span>}
                                        </Td>
                                    </tr>
                                ))}
                            </TBody>
                        </Table>
                        <Pagination currentPage={page} totalPages={totalPages} onChange={(p) => set({ page: p })} />
                    </div>
                )}
            </Card>

            {/* Settlement ledger for this event — renders its own titled card. */}
            <ListingSettlementPanel kind="event" listingId={id} />

            <EventRejectDialog
                key={rejecting ? 'open' : 'closed'}
                event={rejecting ? event : null}
                busy={rejectBusy}
                onCancel={() => setRejecting(false)}
                onReject={reject}
            />
        </div>
    );
}
