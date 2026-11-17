import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { History } from 'lucide-react';
import adminApi from '../api/adminApi';
import { formatInr } from '../lib/formatInr';
import { formatDateTime } from '../lib/formatDateTime';
import { useListParams } from '../lib/useListParams';
import { useRemote } from '../lib/useRemote';
import { cn } from '../lib/cn';
import { Card } from './ui/Card';
import { FigureCard } from './ui/FigureCard';
import { SearchInput } from './ui/SearchInput';
import { StatusBadge } from './ui/StatusBadge';
import { Table, THead, Th, TBody, Td } from './ui/Table';
import { Pagination } from './ui/Pagination';
import { EmptyState, ErrorState, TableSkeleton } from './ui/States';

/**
 * The "Past" tab of a payouts page: every transfer already recorded to
 * organisers (kind 'event') or venue owners (kind 'venue'), newest first. A
 * transfer that was reversed stays listed, struck through, so the history is
 * complete; it does not count towards "Paid out".
 */
export default function PayoutHistory({ kind }) {
    const { params, set } = useListParams({ q: '', page: 1 });
    const load = useCallback(
        () => adminApi.getPayoutHistory({ kind, page: params.page, ...(params.q ? { search: params.q } : {}) }),
        [kind, params.page, params.q]
    );
    const { data, loading, refreshing, error, reload } = useRemote(load);
    const payouts = data?.payouts || [];
    const who = kind === 'venue' ? 'venue owner' : 'organiser';

    return (
        <>
            <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
                <FigureCard label="Paid out" value={loading ? '…' : formatInr(data?.totalPaid || 0)} accent="green" />
                <FigureCard label="Transfers" value={loading ? '…' : String(data?.total || 0)} accent="violet" />
            </div>

            <div className="mb-4 flex justify-end">
                <SearchInput
                    value={params.q}
                    onSearch={(q) => set({ q })}
                    placeholder={`Search ${who}, ${kind === 'venue' ? 'venue' : 'event'} or UTR`}
                    label="Search past payouts"
                />
            </div>

            <Card padded={false} aria-busy={loading || refreshing || undefined} className={cn('overflow-hidden transition-opacity', refreshing && 'opacity-60')}>
                {error ? (
                    <ErrorState title="Couldn't load past payouts" message={error} onRetry={reload} />
                ) : loading ? (
                    <TableSkeleton rows={5} columns={6} />
                ) : payouts.length === 0 ? (
                    <EmptyState
                        icon={History}
                        title={params.q ? 'No payouts match this search' : `No payouts to ${who}s yet`}
                        message={params.q ? `Nothing found for "${params.q}".` : 'Transfers you record on a listing\'s Settlement panel show up here.'}
                    />
                ) : (
                    <Table label={`Past payouts to ${who}s`}>
                        <THead>
                            <Th>Paid on</Th>
                            <Th>Paid to</Th>
                            <Th>For</Th>
                            <Th className="text-right">Amount</Th>
                            <Th>Bank reference</Th>
                            <Th>Recorded by</Th>
                        </THead>
                        <TBody>
                            {payouts.map((p) => (
                                <tr key={p._id} className={p.reversed ? 'bg-red-500/[0.03]' : undefined}>
                                    <Td className="align-top whitespace-nowrap text-gray-300">{formatDateTime(p.settledAt)}</Td>
                                    <Td className="align-top">
                                        {p.recipient ? (
                                            <>
                                                <Link to={`/users/${p.recipient._id}`} className="text-gray-200 hover:text-white">{p.recipient.name || 'Unnamed'}</Link>
                                                <div className="text-xs text-gray-500">{p.recipient.email}</div>
                                            </>
                                        ) : <span className="text-gray-500">Deleted account</span>}
                                    </Td>
                                    <Td className="align-top">
                                        {p.listing.link
                                            ? <Link to={`${p.listing.link}#settlement`} className="text-gray-200 hover:text-violet-300">{p.listing.name}</Link>
                                            : <span className="text-gray-500">{p.listing.name}</span>}
                                        {p.notes && <div className="max-w-[16rem] whitespace-normal text-xs text-gray-500">{p.notes}</div>}
                                    </Td>
                                    <Td className="align-top text-right">
                                        <span className={cn('font-semibold tabular-nums', p.reversed ? 'text-gray-500 line-through' : 'text-white')}>{formatInr(p.amount)}</span>
                                        {p.reversed && (
                                            <div className="mt-1 flex justify-end">
                                                <StatusBadge tone="danger" title={p.reversed.reason || undefined}>Reversed {formatDateTime(p.reversed.at)}</StatusBadge>
                                            </div>
                                        )}
                                    </Td>
                                    <Td className="align-top">
                                        <span className="font-mono text-xs text-gray-300">{p.reference || '—'}</span>
                                        <div className="text-xs text-gray-500">{p.method === 'gateway' ? 'Payment gateway' : 'Bank transfer'}</div>
                                    </Td>
                                    <Td className="align-top text-gray-400">{p.recordedBy || '—'}</Td>
                                </tr>
                            ))}
                        </TBody>
                    </Table>
                )}
                {!loading && !error && (
                    <Pagination currentPage={data?.currentPage || params.page} totalPages={data?.totalPages || 0} onChange={(page) => set({ page })} />
                )}
            </Card>
        </>
    );
}
