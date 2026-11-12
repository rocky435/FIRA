import { useCallback, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ReceiptIndianRupee, CircleCheck, X, Info, CalendarClock, ChevronDown, TriangleAlert } from 'lucide-react';
import adminApi from '../api/adminApi';
import { formatInr } from '../lib/formatInr';
import { formatDateTime } from '../lib/formatDateTime';
import { useListParams } from '../lib/useListParams';
import { useRemote } from '../lib/useRemote';
import { cn } from '../lib/cn';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { FilterTabs } from '../components/ui/FilterTabs';
import { StatusBadge } from '../components/ui/StatusBadge';
import { InfoList } from '../components/ui/InfoList';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Pagination } from '../components/ui/Pagination';
import { EmptyState, ErrorState, TableSkeleton } from '../components/ui/States';
import { useToast } from '../components/ui/toastContext';

const PAGE_SIZE = 20;

// "Refunds to be done": every customer refund (booking rejected or cancelled,
// event removed, venue removed) is raised as a pending request and waits here.
// Refunds are paid manually - from the Razorpay dashboard or by bank transfer -
// and then marked as refunded here with the reference they were paid under.
const TABS = [
    { value: 'pending', label: 'To be done', empty: 'No refunds waiting', emptyMessage: 'Refunds appear here when a booking is cancelled or rejected, or an event or venue is removed.' },
    { value: 'completed', label: 'Refunded', empty: 'No refunds paid yet' },
    { value: 'rejected', label: 'Rejected', empty: 'No rejected refunds' },
    { value: 'all', label: 'All', empty: 'No refunds yet' },
];

const REASON_LABELS = {
    event_cancelled: 'Event cancelled',
    booking_cancelled: 'Booking cancelled',
    user_request: 'Ticket cancelled',
    duplicate_payment: 'Duplicate payment',
    admin_initiated: 'Admin initiated',
    other: 'Other',
};

// The refund's own word for "paid" is completed; the admin reads "Refunded".
const STATUS_LABEL = { completed: 'Refunded', pending: 'To be done' };

const actionable = (r) => r.status === 'pending' || r.status === 'failed';

/**
 * Dialog for one decision on one refund. "pay" records a refund already paid
 * outside FIRA and needs the reference it was paid under; "reject" needs the
 * reason, which the customer sees. Same calls and rules as before.
 */
function DecisionDialog({ decision, onClose, onDone }) {
    const toast = useToast();
    const fieldId = useId();
    const [text, setText] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const refund = decision?.refund;
    const paying = decision?.kind === 'pay';

    const submit = async () => {
        const value = text.trim();
        if (!value) {
            setError(paying ? 'Enter the Razorpay refund ID or bank UTR you paid it under.' : 'Enter a reason - the customer will see it.');
            return;
        }
        setBusy(true);
        setError('');
        try {
            if (paying) await adminApi.processRefund(refund._id, 'approve', '', value);
            else await adminApi.processRefund(refund._id, 'reject', value);
            toast.success(paying
                ? `${formatInr(refund.amount)} marked as refunded. The customer is notified.`
                : `Refund of ${formatInr(refund.amount)} rejected. The customer is notified.`);
            onDone();
        } catch (err) {
            setError(err?.message || (paying ? 'Approval failed' : 'Rejection failed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open={Boolean(refund)}
            onClose={onClose}
            dismissible={!busy}
            title={paying ? `Mark ${formatInr(refund?.amount)} as refunded?` : `Reject this ${formatInr(refund?.amount)} refund?`}
            description={refund ? `${refund.user?.name || 'Customer'}${refund.user?.email ? ` · ${refund.user.email}` : ''}` : undefined}
            footer={(
                <>
                    <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button variant={paying ? 'success' : 'danger'} onClick={submit} isLoading={busy}>
                        {paying ? 'Confirm refunded' : 'Reject refund'}
                    </Button>
                </>
            )}
        >
            {paying && (
                <p className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3 text-sm text-amber-100/80">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
                    Only do this after the money has been sent, from the Razorpay dashboard or by bank transfer. This does not send any money.
                </p>
            )}
            <label htmlFor={fieldId} className="mb-1.5 block text-sm font-medium text-gray-300">
                {paying ? 'Razorpay refund ID or bank UTR' : 'Reason (shown to the customer)'}
            </label>
            {paying ? (
                <input
                    id={fieldId}
                    value={text}
                    onChange={(e) => { setText(e.target.value); setError(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                    placeholder="e.g. rfnd_Nx8… or a 12-digit UTR"
                    autoComplete="off"
                    aria-invalid={Boolean(error)}
                    className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:border-violet-500/60 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                />
            ) : (
                <textarea
                    id={fieldId}
                    value={text}
                    onChange={(e) => { setText(e.target.value); setError(''); }}
                    rows={4}
                    placeholder="e.g. Already refunded by the venue directly."
                    aria-invalid={Boolean(error)}
                    className="w-full resize-none rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:border-violet-500/60 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                />
            )}
            {error && <p role="alert" className="mt-2 text-sm text-red-400">{error}</p>}
        </Modal>
    );
}

// Why a venue booking ended, in words (Booking.cancellationReason codes).
const BOOKING_CANCEL_REASON = {
    cancelled_by_guest: 'The guest cancelled the booking',
    venue_did_not_respond: "The venue owner didn't answer the request in time",
    payment_not_received: "The guest didn't pay in time after the owner accepted",
    missed_payment_deadline: 'The guest missed the balance payment deadline',
    venue_removed: 'The venue was removed from FIRA',
    event_cancelled: 'The event using this booking was cancelled',
};

const formatDay = (value) => {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

/** One sentence answering "why is this refund here?" from everything the server sent. */
function whyText(r) {
    const b = r.context?.booking;
    const ev = r.context?.event;
    if (b) {
        const where = [b.venue?.name, formatDay(b.bookingDate)].filter(Boolean).join(' on ');
        const why = b.status === 'rejected'
            ? `The venue owner rejected the booking${b.rejectionReason ? `: "${b.rejectionReason}"` : ''}`
            : BOOKING_CANCEL_REASON[b.cancellationReason] || (b.status === 'cancelled' ? 'The booking was cancelled' : `Booking is ${b.status}`);
        return `${why}${where ? ` (${where})` : ''}.`;
    }
    if (ev) {
        const n = (r.context.tickets || []).reduce((sum, t) => sum + (t.quantity || 1), 0);
        const what = `${n || 'Some'} ticket${n === 1 ? '' : 's'} for ${ev.name}`;
        if (r.reason === 'event_cancelled' || ev.status === 'cancelled') return `${what} - the event was cancelled or removed.`;
        if (r.reason === 'user_request') return `${what} - the customer cancelled their ticket.`;
        return `${what}.`;
    }
    return REASON_LABELS[r.reason] || 'Refund requested.';
}

function Section({ title, children }) {
    return (
        <section className="rounded-xl border border-line bg-surface-raised p-4">
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</h4>
            {children}
        </section>
    );
}

/** The full story behind one refund: what it paid for, the payment, the customer, the decision. */
function RefundDetails({ refund: r }) {
    const b = r.context?.booking;
    const ev = r.context?.event;
    const tickets = r.context?.tickets || [];
    const p = r.payment && typeof r.payment === 'object' ? r.payment : null;
    const paid = p ? (p.totalAmount || p.amount) : null;
    const share = paid ? Math.round((Number(r.amount) / Number(paid)) * 100) : null;
    const history = r.context?.customerRefunds;
    const policy = b?.venue?.cancellationPolicy;

    return (
        <div className="grid gap-3 lg:grid-cols-2">
            {b && (
                <Section title="Venue booking">
                    <InfoList items={[
                        { label: 'Venue', value: b.venue ? <Link to={`/venues/${b.venue._id}`} className="hover:text-violet-300">{b.venue.name}{b.venue.city ? `, ${b.venue.city}` : ''}</Link> : null },
                        { label: 'Date', value: [formatDay(b.bookingDate), b.endDate && formatDay(b.endDate) !== formatDay(b.bookingDate) ? `to ${formatDay(b.endDate)}` : null, b.startTime && b.endTime ? `${b.startTime}–${b.endTime}` : null].filter(Boolean).join(' ') || null },
                        { label: 'Booking status', value: <StatusBadge value={b.status} /> },
                        { label: 'Why it ended', value: b.status === 'rejected' ? `Rejected by the venue${b.rejectionReason ? `: ${b.rejectionReason}` : ''}` : BOOKING_CANCEL_REASON[b.cancellationReason] || b.cancellationReason },
                        { label: 'For event', value: b.event ? <Link to={`/events/${b.event._id}`} className="hover:text-violet-300">{b.event.name}</Link> : null },
                        { label: 'Purpose', value: b.purpose },
                        { label: 'Guests expected', value: b.expectedGuests ? String(b.expectedGuests) : null },
                        { label: 'Booking total', value: b.totalAmount != null ? formatInr(b.totalAmount) : null },
                        { label: 'This refund is for', value: b.paymentSchedule?.type === 'installment' ? `The ${b.charge} (advance ${formatInr(b.paymentSchedule.depositAmount || 0)}, balance ${formatInr(b.paymentSchedule.balanceAmount || 0)} - ${String(b.paymentSchedule.balanceStatus || '').replace(/_/g, ' ')})` : 'The full payment' },
                        { label: 'Booked on', value: formatDay(b.createdAt) },
                        {
                            label: 'Venue cancellation policy',
                            wide: true,
                            // Venue.cancellationPolicy: full refund before freeCancellationHours,
                            // partialRefundPercentage until noCancellationHours, nothing after.
                            value: policy && policy.freeCancellationHours != null
                                ? `Full refund if cancelled ${policy.freeCancellationHours}+ hours before · ${policy.partialRefundPercentage ?? 0}% until ${policy.noCancellationHours ?? 0} hours before · nothing after that`
                                : null,
                        },
                    ]} />
                </Section>
            )}

            {ev && (
                <Section title="Tickets">
                    <InfoList items={[
                        { label: 'Event', value: <Link to={`/events/${ev._id}`} className="hover:text-violet-300">{ev.name}</Link> },
                        { label: 'Event status', value: <StatusBadge value={ev.status} /> },
                        { label: 'Event date', value: formatDateTime(ev.startDateTime) },
                        { label: 'Organizer', value: ev.organizer ? `${ev.organizer.name || 'Unnamed'}${ev.organizer.email ? ` · ${ev.organizer.email}` : ''}` : null },
                    ]} />
                    {tickets.length > 0 && (
                        <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
                            {tickets.map((t) => (
                                <li key={t._id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                                    <span className="text-gray-200">
                                        {t.ticketType || 'General'} × {t.quantity || 1}
                                        {t.ticketId && <span className="ml-2 font-mono text-xs text-gray-500">{t.ticketId}</span>}
                                    </span>
                                    <span className="flex items-center gap-2">
                                        <span className="tabular-nums text-gray-300">{formatInr(t.price || 0)}</span>
                                        {/* A used ticket means the customer got in - worth knowing before refunding. */}
                                        {t.isUsed ? <StatusBadge tone="warning">Checked in {t.usedAt ? formatDay(t.usedAt) : ''}</StatusBadge> : <StatusBadge value={t.status} />}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Section>
            )}

            {p && (
                <Section title="Original payment">
                    <InfoList items={[
                        { label: 'Paid', value: paid != null ? `${formatInr(paid)}${share != null && share < 100 ? ` · this refund is ${share}% of it` : ''}` : null },
                        { label: 'Paid on', value: p.paidAt ? formatDateTime(p.paidAt) : formatDateTime(p.createdAt) },
                        { label: 'Subtotal', value: p.subtotal != null ? formatInr(p.subtotal) : null },
                        { label: 'GST', value: p.gstAmount ? formatInr(p.gstAmount) : null },
                        { label: 'Platform fee', value: p.platformFee ? formatInr(p.platformFee) : null },
                        { label: 'Discount', value: p.discountAmount ? `${formatInr(p.discountAmount)}${typeof p.discountCode === 'string' ? ` (${p.discountCode})` : ''}` : null },
                        { label: 'Method', value: p.paymentMethod },
                        { label: 'Payment status', value: p.status ? <StatusBadge value={p.status === 'success' ? 'paid' : p.status} /> : null },
                        { label: 'Razorpay payment ID', value: p.gatewayTransactionId ? <span className="font-mono text-xs">{p.gatewayTransactionId}</span> : null, wide: true },
                        { label: 'Razorpay order ID', value: p.gatewayOrderId ? <span className="font-mono text-xs">{p.gatewayOrderId}</span> : null, wide: true },
                    ]} />
                </Section>
            )}

            <Section title="Customer and decision">
                <InfoList items={[
                    { label: 'Customer', value: r.user?._id ? <Link to={`/users/${r.user._id}`} className="hover:text-violet-300">{r.user.name || 'Unnamed'}</Link> : r.user?.name },
                    { label: 'Email', value: r.user?.email },
                    { label: 'Phone', value: r.user?.phone ? <a href={`tel:${r.user.phone}`} className="hover:text-violet-300">{r.user.phone}</a> : null },
                    {
                        label: 'Refund history',
                        value: history ? `${history.total} refund${history.total === 1 ? '' : 's'} in total, ${history.refunded} paid` : null,
                    },
                    { label: 'Requested', value: formatDateTime(r.requestedAt || r.createdAt) },
                    { label: 'Full or part', value: r.refundType === 'partial' ? 'Part refund' : r.refundType === 'full' ? 'Full refund' : null },
                    { label: 'Decided by', value: r.reviewedBy ? `${r.reviewedBy.name || 'Admin'}${r.reviewedBy.email ? ` · ${r.reviewedBy.email}` : ''}` : null },
                    { label: 'Decided on', value: r.reviewedAt ? formatDateTime(r.reviewedAt) : null },
                    { label: 'Reference', value: r.gatewayRefundId ? <span className="font-mono text-xs">{r.gatewayRefundId}</span> : null },
                    { label: 'Admin notes', value: r.adminNotes, wide: true },
                    { label: 'Details recorded', value: r.reasonDetails, wide: true },
                ]} />
            </Section>
        </div>
    );
}

function RefundRow({ refund: r, onPay, onReject }) {
    const [open, setOpen] = useState(false);
    const detailsId = useId();
    const repeat = (r.context?.customerRefunds?.total || 0) > 2;
    return (
        <li className="px-5 py-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-lg font-semibold tabular-nums text-white">{formatInr(r.amount)}</span>
                        <StatusBadge value={r.status}>{STATUS_LABEL[r.status]}</StatusBadge>
                        <StatusBadge tone="neutral">{REASON_LABELS[r.reason] || r.reason || 'Refund'}</StatusBadge>
                        {repeat && (
                            <StatusBadge tone="warning" icon={TriangleAlert} title="This customer has had several refunds">
                                {r.context.customerRefunds.total} refunds for this customer
                            </StatusBadge>
                        )}
                    </div>
                    {/* The answer to "why is this here?", before anything else. */}
                    <p className="text-sm text-white"><span className="text-gray-400">Why: </span>{whyText(r)}</p>
                    <p className="text-sm text-gray-300">
                        {r.user?._id
                            ? <Link to={`/users/${r.user._id}`} className="hover:text-violet-300">{r.user.name || 'Unknown customer'}</Link>
                            : (r.user?.name || 'Unknown customer')}
                        {r.user?.email && <span className="text-gray-500"> · {r.user.email}</span>}
                        {r.user?.phone && <span className="text-gray-500"> · {r.user.phone}</span>}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-gray-500">
                        <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                        Requested {formatDateTime(r.requestedAt || r.createdAt)}
                        {r.payment?.totalAmount != null && <span>· paid {formatInr(r.payment.totalAmount || r.payment.amount)}</span>}
                        {r.reviewedAt && <span>· decided {formatDateTime(r.reviewedAt)}{r.reviewedBy?.name ? ` by ${r.reviewedBy.name}` : ''}</span>}
                    </p>
                    {r.status === 'completed' && r.gatewayRefundId && (
                        <p className="text-sm text-gray-400">Reference: <span className="font-mono text-gray-200">{r.gatewayRefundId}</span></p>
                    )}
                    {r.status === 'rejected' && r.rejectionReason && (
                        <p className="text-sm text-gray-400">Rejected: {r.rejectionReason}</p>
                    )}
                    {r.status === 'failed' && r.failureReason && (
                        <p className="text-sm text-red-300">Failed: {r.failureReason}</p>
                    )}
                </div>

                <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setOpen((v) => !v)}
                        aria-expanded={open}
                        aria-controls={detailsId}
                        rightIcon={<ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden="true" />}
                    >
                        {open ? 'Hide details' : 'Details'}
                    </Button>
                    {actionable(r) && (
                        <>
                            <Button variant="success" size="sm" onClick={onPay} leftIcon={<CircleCheck className="h-4 w-4" aria-hidden="true" />}>Mark as refunded</Button>
                            <Button variant="secondary" size="sm" onClick={onReject} leftIcon={<X className="h-4 w-4" aria-hidden="true" />}>Reject</Button>
                        </>
                    )}
                </div>
            </div>
            {open && <div id={detailsId} className="mt-4"><RefundDetails refund={r} /></div>}
        </li>
    );
}

export default function Refunds() {
    const { params, set } = useListParams({ status: 'pending', page: 1 });
    const tab = TABS.find((t) => t.value === params.status) || TABS[0];
    const load = useCallback(() => {
        const query = { page: params.page, limit: PAGE_SIZE };
        if (tab.value !== 'all') query.status = tab.value;
        return adminApi.getRefunds(query);
    }, [tab.value, params.page]);
    const { data, loading, refreshing, error, reload } = useRemote(load);
    const [decision, setDecision] = useState(null);

    const refunds = data?.refunds || [];
    const total = data?.total || 0;
    const pendingOnPage = refunds.filter(actionable).reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader
                title="Refunds"
                description="Pay each refund manually (Razorpay dashboard or bank transfer), then mark it as refunded here with its reference. The customer is notified."
                count={loading ? null : total}
            />

            <FilterTabs label="Refund status" className="mb-4" options={TABS} value={tab.value} onChange={(v) => set({ status: v })} />

            <Card padded={false} aria-busy={loading || refreshing || undefined} className={cn('overflow-hidden transition-opacity', refreshing && 'opacity-60')}>
                {error ? (
                    <ErrorState title="Couldn't load refunds" message={error} onRetry={reload} />
                ) : loading ? (
                    <TableSkeleton rows={4} columns={3} />
                ) : refunds.length === 0 ? (
                    <EmptyState icon={ReceiptIndianRupee} title={tab.empty} message={tab.emptyMessage} />
                ) : (
                    <>
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3 text-sm text-gray-400">
                            <span>{total.toLocaleString('en-IN')} refund{total === 1 ? '' : 's'}</span>
                            {pendingOnPage > 0 && <span>To pay on this page: <span className="font-medium tabular-nums text-white">{formatInr(pendingOnPage)}</span></span>}
                        </div>
                        <ul className="divide-y divide-line">
                            {refunds.map((r) => (
                                <RefundRow
                                    key={r._id}
                                    refund={r}
                                    onPay={() => setDecision({ kind: 'pay', refund: r })}
                                    onReject={() => setDecision({ kind: 'reject', refund: r })}
                                />
                            ))}
                        </ul>
                        <Pagination currentPage={params.page} totalPages={data?.totalPages || 1} onChange={(page) => set({ page })} />
                    </>
                )}
            </Card>

            {/* Keyed per refund and decision so each opening starts empty. */}
            <DecisionDialog
                key={decision ? `${decision.kind}-${decision.refund._id}` : 'closed'}
                decision={decision}
                onClose={() => setDecision(null)}
                onDone={() => { setDecision(null); reload(); }}
            />
        </div>
    );
}
