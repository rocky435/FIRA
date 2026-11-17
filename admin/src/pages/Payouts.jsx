import { useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Wallet, TriangleAlert } from 'lucide-react';
import adminApi from '../api/adminApi';
import { formatInr } from '../lib/formatInr';
import { formatDateTime } from '../lib/formatDateTime';
import { formatRate } from '../lib/settlementView';
import { useListParams } from '../lib/useListParams';
import { useRemote } from '../lib/useRemote';
import { cn } from '../lib/cn';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { FigureCard } from '../components/ui/FigureCard';
import { FilterTabs } from '../components/ui/FilterTabs';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Table, THead, Th, TBody, Td } from '../components/ui/Table';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorState, Skeleton, TableSkeleton } from '../components/ui/States';
import PayoutHistory from '../components/PayoutHistory';

const KINDS = [
    { value: 'all', label: 'All' },
    { value: 'venue', label: 'Venues' },
    { value: 'event', label: 'Events' },
];

const detailPath = (row) => `/${row.kind === 'venue' ? 'venues' : 'events'}/${row.id}#settlement`;

/**
 * Everyone the platform owes money to, across every venue and event, so an
 * admin never has to open each listing to find out who to pay.
 *
 * The figures are the same ones each listing's Settlement panel shows; paying
 * is still recorded there (the "Pay" link opens it), so every transfer keeps
 * its UTR and audit entry. This page reads and links only - no money moves here.
 */
// `fixedKind` comes from the two menu entries (Payouts to organisers / to venue
// owners): the page shows only that kind and drops the kind tabs.
const FIXED = {
    event: { title: 'Payouts to organisers', description: 'What each event organiser is owed from ticket sales, most owed first.' },
    venue: { title: 'Payouts to venue owners', description: 'What each venue owner is owed from bookings, most owed first.' },
};

// The two menu pages split into what is still to pay and what has been paid.
const VIEWS = [
    { value: 'due', label: 'To be done' },
    { value: 'past', label: 'Past' },
];

export default function Payouts({ fixedKind }) {
    const { params, set } = useListParams({ view: 'due' });
    const fixed = FIXED[fixedKind];
    const view = fixed && params.view === 'past' ? 'past' : 'due';
    // q and page belong to the Past list; drop them when going back.
    const tabs = fixed ? (
        <FilterTabs label="Payouts shown" options={VIEWS} value={view} onChange={(v) => set({ view: v, q: '', page: '' })} className="mb-5" />
    ) : null;

    if (view === 'past') {
        return (
            <div className="p-4 sm:p-6 lg:p-8">
                <PageHeader
                    title={fixed.title}
                    description={`Every transfer already made to ${fixedKind === 'venue' ? 'venue owners' : 'organisers'}, newest first.`}
                />
                {tabs}
                <PayoutHistory kind={fixedKind} />
            </div>
        );
    }
    return <PayoutQueue fixedKind={fixedKind} tabs={tabs} />;
}

function PayoutQueue({ fixedKind, tabs }) {
    // Kind and the "show fully paid" switch live in the URL, so back/refresh keep them.
    const { params, set } = useListParams({ kind: 'all', settled: '' });
    const kind = FIXED[fixedKind] ? fixedKind : (KINDS.some((k) => k.value === params.kind) ? params.kind : 'all');
    const heading = FIXED[fixedKind] || { title: 'Payouts', description: 'What each venue owner and organiser is owed, most owed first.' };
    const showSettled = params.settled === '1';

    const load = useCallback(() => adminApi.getPayoutQueue(kind), [kind]);
    const { data, loading, refreshing, error, reload } = useRemote(load);

    const rows = useMemo(() => {
        const all = data?.rows || [];
        return showSettled ? all : all.filter((r) => r.error || r.money.outstandingAmount > 0.01 || r.money.excessAmount > 0.01);
    }, [data, showSettled]);
    const hiddenCount = (data?.rows?.length || 0) - rows.length;
    const totals = data?.totals;

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader
                title={heading.title}
                description={heading.description}
                actions={(
                    <Button variant="secondary" onClick={reload} isLoading={refreshing} disabled={loading} leftIcon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}>
                        Refresh
                    </Button>
                )}
            />
            {tabs}

            {totals ? (
                <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
                    <FigureCard label="Ready to pay" value={formatInr(totals.dueNow)} accent="green" />
                    <FigureCard label="Owed in total" value={formatInr(totals.outstanding)} accent="orange" />
                    <FigureCard label="Owners waiting" value={String(totals.owedListings)} accent="violet" />
                    <FigureCard label="Can't pay yet" value={String(totals.blockedListings)} accent={totals.blockedListings ? 'red' : 'blue'} />
                </div>
            ) : loading && (
                <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4" role="status" aria-label="Loading">
                    {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
                </div>
            )}
            <p className="mb-6 max-w-3xl text-sm text-gray-400">
                <span className="text-gray-200">Ready to pay</span> is money from bookings and events that have already happened.
                {' '}<span className="text-gray-200">Upcoming</span> is for dates still to come, and goes back to the guest if they cancel, so wait until the date has passed.
                {' '}Amounts are the owner&apos;s share: what guests paid, minus FIRA&apos;s fee and GST, and minus FIRA&apos;s commission where one is set.
            </p>

            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                {FIXED[fixedKind] ? <span /> : <FilterTabs label="Listing type" options={KINDS} value={kind} onChange={(v) => set({ kind: v })} />}
                <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-gray-300">
                    <input
                        type="checkbox"
                        checked={showSettled}
                        onChange={(e) => set({ settled: e.target.checked ? '1' : '' })}
                        className="h-4 w-4 accent-violet-500"
                    />
                    Show fully paid listings{hiddenCount > 0 && !showSettled ? ` (${hiddenCount})` : ''}
                </label>
            </div>

            <Card padded={false} aria-busy={loading || refreshing || undefined} className={cn('overflow-hidden transition-opacity', refreshing && 'opacity-60')}>
                {error ? (
                    <ErrorState title="Couldn't load payouts" message={error} onRetry={reload} />
                ) : loading ? (
                    <TableSkeleton rows={5} columns={6} />
                ) : rows.length === 0 ? (
                    <EmptyState icon={Wallet} title="Nobody is waiting to be paid" message="Listings appear here once a guest pays for a booking or a ticket." />
                ) : (
                    <Table label="Payouts owed">
                        <THead>
                            <Th>Listing</Th>
                            <Th>Owner</Th>
                            <Th className="text-right">Owner&apos;s share</Th>
                            <Th className="text-right">Paid out</Th>
                            <Th className="text-right">Ready to pay</Th>
                            <Th className="text-right">Upcoming</Th>
                            <Th>Pay to</Th>
                            <Th><span className="sr-only">Action</span></Th>
                        </THead>
                        <TBody>
                            {rows.map((row) => <PayoutRow key={`${row.kind}-${row.id}`} row={row} />)}
                        </TBody>
                    </Table>
                )}
            </Card>
            {data?.generatedAt && (
                <p className="mt-3 text-xs text-gray-500">Worked out {formatDateTime(data.generatedAt)}.</p>
            )}
        </div>
    );
}

function PayoutRow({ row }) {
    const listing = (
        <Td className="align-top">
            <Link to={detailPath(row)} className="font-medium text-white hover:text-violet-300">{row.name || 'Untitled'}</Link>
            <div className="mt-1 flex items-center gap-1.5">
                <StatusBadge tone={row.kind === 'venue' ? 'info' : 'accent'}>{row.kind === 'venue' ? 'Venue' : 'Event'}</StatusBadge>
                {row.deleted && <StatusBadge tone="neutral">Deleted listing</StatusBadge>}
            </div>
        </Td>
    );
    const owner = (
        <Td className="align-top">
            {row.owner ? (
                <>
                    <Link to={`/users/${row.owner.id}`} className="text-gray-200 hover:text-white">{row.owner.name || 'Unnamed'}</Link>
                    <div className="text-xs text-gray-500">{row.owner.email}</div>
                </>
            ) : <span className="text-gray-500">No owner</span>}
        </Td>
    );

    if (row.error) {
        return (
            <tr className="bg-red-500/[0.04]">
                {listing}
                {owner}
                <Td colSpan={5} className="align-top whitespace-normal text-red-300">
                    <span className="inline-flex items-start gap-2">
                        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        {row.error}. Open the listing to see why before paying anything.
                    </span>
                </Td>
                <Td className="align-top text-right">
                    <Link to={detailPath(row)} className="text-violet-300 hover:text-violet-200">Open</Link>
                </Td>
            </tr>
        );
    }

    const m = row.money;
    const owed = m.outstandingAmount > 0.01;
    return (
        <tr>
            {listing}
            {owner}
            <Td className="align-top text-right tabular-nums text-gray-200">
                {formatInr(m.netPayable)}
                {/* FIRA's commission is already taken off this figure. */}
                {m.commissionPercentage > 0 && (
                    <div className="text-xs text-gray-500">after {formatRate(m.commissionPercentage)}% commission ({formatInr(m.commissionAmount)})</div>
                )}
            </Td>
            <Td className="align-top text-right tabular-nums text-gray-400">
                {formatInr(m.settledToDate)}
                {m.excessAmount > 0.01 && <div className="text-xs text-red-300">Overpaid {formatInr(m.excessAmount)}</div>}
            </Td>
            <Td className={cn('align-top text-right font-semibold tabular-nums', m.dueNow > 0.01 ? 'text-green-300' : 'text-gray-500')}>
                {formatInr(m.dueNow)}
            </Td>
            <Td className="align-top text-right tabular-nums text-gray-400">{formatInr(m.upcoming)}</Td>
            <Td className="align-top">
                {row.blockedReason ? (
                    <BlockedNote row={row} />
                ) : row.payTo ? (
                    <div>
                        <div className="text-gray-200">{row.payTo.bankName} <span className="tabular-nums">{row.payTo.accountNumber}</span></div>
                        <div className="text-xs text-gray-500">{row.payTo.accountName} · {row.payTo.ifscCode}</div>
                    </div>
                ) : null}
            </Td>
            <Td className="align-top text-right">
                {owed ? (
                    <Link
                        to={detailPath(row)}
                        className="inline-flex h-8 items-center rounded-xl bg-violet-600 px-3 text-sm font-medium text-white hover:bg-violet-700"
                    >
                        Pay
                    </Link>
                ) : (
                    <Link to={detailPath(row)} className="text-gray-400 hover:text-white">View</Link>
                )}
            </Td>
        </tr>
    );
}

function BlockedNote({ row }) {
    const fix = row.blockedReason === 'PAN not verified'
        ? (row.idCheck?.status === 'pending'
            ? <Link to="/id-checks" className="text-violet-300 hover:text-violet-200">Review in ID Checks</Link>
            : 'The organiser needs to add their PAN in Settings')
        : row.blockedReason === 'No bank account saved'
            ? 'Ask the owner to add a payout account in Settings'
            : null;
    return (
        <div>
            <div className="font-medium text-amber-300">{row.blockedReason}</div>
            {fix && <div className="mt-0.5 text-xs text-gray-400">{fix}</div>}
        </div>
    );
}
