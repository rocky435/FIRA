import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { CreditCard } from 'lucide-react';
import adminApi from '../api/adminApi';
import { formatInr } from '../lib/formatInr';
import { formatDateTime } from '../lib/formatDateTime';
import { useListParams } from '../lib/useListParams';
import { useRemote } from '../lib/useRemote';
import { cn } from '../lib/cn';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { FilterTabs } from '../components/ui/FilterTabs';
import { SearchInput } from '../components/ui/SearchInput';
import { Select } from '../components/ui/Select';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Table, THead, Th, TBody, Td } from '../components/ui/Table';
import { Pagination } from '../components/ui/Pagination';
import { EmptyState, ErrorState, TableSkeleton } from '../components/ui/States';

const STATUSES = [
    { value: 'all', label: 'All' },
    { value: 'success', label: 'Successful' },
    { value: 'failed', label: 'Failed' },
    { value: 'refunded', label: 'Refunded' },
    { value: 'pending', label: 'Pending' },
];
const KINDS = [
    { value: 'all', label: 'Tickets and venues' },
    { value: 'ticket', label: 'Tickets only' },
    { value: 'venue', label: 'Venue bookings only' },
];
const STATUS_SHOWN = {
    success: { tone: 'success', label: 'Successful' },
    failed: { tone: 'danger', label: 'Failed' },
    refunded: { tone: 'neutral', label: 'Refunded' },
    pending: { tone: 'warning', label: 'Pending' },
    processing: { tone: 'warning', label: 'Processing' },
};
const METHOD = { upi: 'UPI', card: 'Card', netbanking: 'Netbanking', wallet: 'Wallet' };

/**
 * Every payment on FIRA in one list: who paid, for what, how much, how, and how
 * it ended - including the ones that failed, which no other page shows.
 */
export default function Payments() {
    const { params, set } = useListParams({ status: 'all', kind: 'all', q: '', page: 1 });
    const status = STATUSES.some((s) => s.value === params.status) ? params.status : 'all';
    const kind = KINDS.some((k) => k.value === params.kind) ? params.kind : 'all';

    const load = useCallback(() => {
        const query = { page: params.page, status, kind };
        if (params.q) query.search = params.q;
        return adminApi.getPayments(query);
    }, [params.page, params.q, status, kind]);
    const { data, loading, refreshing, error, reload } = useRemote(load);
    const payments = data?.payments || [];
    const counts = data?.counts || {};

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader
                title="Payments"
                description={data ? `Every payment guests made. ${formatInr(data.successTotal)} successful in this view.` : 'Every payment guests made, including failed ones.'}
                count={loading ? null : data?.total}
            />

            <div className="mb-4 flex flex-col gap-3">
                <FilterTabs
                    label="Payment status"
                    options={STATUSES.map((s) => ({ ...s, count: counts[s.value] }))}
                    value={status}
                    onChange={(v) => set({ status: v })}
                />
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className="sm:w-56">
                        <Select aria-label="Payment for" value={kind} onChange={(e) => set({ kind: e.target.value })} options={KINDS} />
                    </div>
                    <SearchInput value={params.q} onSearch={(q) => set({ q })} placeholder="Name, email, phone or Razorpay ID" label="Search payments" />
                </div>
            </div>

            <Card padded={false} aria-busy={loading || refreshing || undefined} className={cn('overflow-hidden transition-opacity', refreshing && 'opacity-60')}>
                {error ? (
                    <ErrorState title="Couldn't load payments" message={error} onRetry={reload} />
                ) : loading ? (
                    <TableSkeleton rows={8} columns={6} />
                ) : payments.length === 0 ? (
                    <EmptyState
                        icon={CreditCard}
                        title={params.q || status !== 'all' || kind !== 'all' ? 'No payments match these filters' : 'No payments yet'}
                        message={params.q ? `Nothing found for "${params.q}".` : undefined}
                    />
                ) : (
                    <Table label="Payments" className="min-w-[860px]">
                        <THead>
                            <Th>When</Th>
                            <Th>Paid by</Th>
                            <Th>For</Th>
                            <Th className="text-right">Amount</Th>
                            <Th>Status</Th>
                            <Th>Razorpay</Th>
                        </THead>
                        <TBody>
                            {payments.map((p) => {
                                const shown = STATUS_SHOWN[p.status] || { tone: 'neutral', label: p.status };
                                return (
                                    <tr key={p._id}>
                                        <Td className="align-top whitespace-nowrap text-gray-300">{formatDateTime(p.paidAt || p.createdAt)}</Td>
                                        <Td className="align-top">
                                            {p.user ? (
                                                <>
                                                    <Link to={`/users/${p.user._id}`} className="text-gray-200 hover:text-white">{p.user.name || 'Unnamed'}</Link>
                                                    <div className="break-all text-xs text-gray-500">{p.user.email}{p.user.phone ? ` · ${p.user.phone}` : ''}</div>
                                                </>
                                            ) : <span className="text-gray-500">Deleted account</span>}
                                        </Td>
                                        <Td className="align-top">
                                            <StatusBadge tone={p.kind === 'venue' ? 'info' : 'accent'} className="mb-1">{p.kind === 'venue' ? 'Venue booking' : 'Tickets'}</StatusBadge>
                                            <div>
                                                {p.for?.link
                                                    ? <Link to={p.for.link} className="text-gray-200 hover:text-violet-300">{p.for.name}</Link>
                                                    : <span className="text-gray-500">{p.for?.name || '—'}</span>}
                                            </div>
                                        </Td>
                                        <Td className="align-top text-right">
                                            <span className="font-semibold tabular-nums text-white">{formatInr(p.amount)}</span>
                                            {p.discountCode && (
                                                <div className="text-xs text-gray-500">Code {p.discountCode}{p.discountAmount ? ` · −${formatInr(p.discountAmount)}` : ''}</div>
                                            )}
                                            {p.method && <div className="text-xs text-gray-500">{METHOD[p.method] || p.method}</div>}
                                        </Td>
                                        <Td className="align-top">
                                            <StatusBadge tone={shown.tone}>{shown.label}</StatusBadge>
                                            {p.failureReason && <div className="mt-1 max-w-[14rem] whitespace-normal text-xs text-red-300">{p.failureReason}</div>}
                                        </Td>
                                        <Td className="align-top">
                                            <span className="font-mono text-xs text-gray-400">{p.razorpayPaymentId || p.razorpayOrderId || '—'}</span>
                                        </Td>
                                    </tr>
                                );
                            })}
                        </TBody>
                    </Table>
                )}
                {!loading && !error && (
                    <Pagination currentPage={data?.currentPage || params.page} totalPages={data?.totalPages || 0} onChange={(page) => set({ page })} />
                )}
            </Card>
        </div>
    );
}
