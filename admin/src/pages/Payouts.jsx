import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import adminApi from '../api/adminApi';
import { FadeIn } from '../components/animations';
import { FigureCard } from '../components/ui/FigureCard';
import { formatInr } from '../lib/formatInr';
import { formatDateTime } from '../lib/formatDateTime';

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
 * its UTR and audit entry.
 */
export default function Payouts() {
    const [kind, setKind] = useState('all');
    const [showSettled, setShowSettled] = useState(false);
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            setData(await adminApi.getPayoutQueue(kind));
        } catch (err) {
            setError(err.message || 'Failed to load payouts');
            setData(null);
        } finally {
            setLoading(false);
        }
    }, [kind]);

    useEffect(() => { load(); }, [load]);

    const rows = useMemo(() => {
        const all = data?.rows || [];
        return showSettled ? all : all.filter(r => r.error || r.money.outstandingAmount > 0.01 || r.money.excessAmount > 0.01);
    }, [data, showSettled]);
    const hiddenCount = (data?.rows?.length || 0) - rows.length;
    const totals = data?.totals;

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <FadeIn>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
                    <div>
                        <h1 className="text-3xl font-bold text-white mb-2">Payouts to owners</h1>
                        <p className="text-gray-300">What each venue owner and organiser is owed, most owed first.</p>
                    </div>
                    <button
                        type="button"
                        onClick={load}
                        disabled={loading}
                        className="px-4 py-2 rounded-lg bg-white/[0.08] text-white text-sm hover:bg-white/[0.14] transition-colors disabled:opacity-50 self-start md:self-auto"
                    >
                        {loading ? 'Loading…' : 'Refresh'}
                    </button>
                </div>

                {totals && (
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                        <FigureCard label="Ready to pay" value={formatInr(totals.dueNow)} accent="green" />
                        <FigureCard label="Owed in total" value={formatInr(totals.outstanding)} accent="orange" />
                        <FigureCard label="Owners waiting" value={String(totals.owedListings)} accent="violet" />
                        <FigureCard label="Can't pay yet" value={String(totals.blockedListings)} accent={totals.blockedListings ? 'red' : 'blue'} />
                    </div>
                )}
                <p className="text-sm text-gray-400 mb-6 max-w-3xl">
                    <span className="text-gray-200">Ready to pay</span> is money from bookings and events that have already happened.
                    {' '}<span className="text-gray-200">Upcoming</span> is for dates still to come, and goes back to the guest if they cancel, so wait until the date has passed.
                    Amounts are the owner&apos;s share: what guests paid, minus FIRA&apos;s fee and GST.
                </p>

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                    <div className="flex gap-2 overflow-x-auto pb-1">
                        {KINDS.map(k => (
                            <button
                                key={k.value}
                                type="button"
                                onClick={() => setKind(k.value)}
                                className={`px-4 py-2 rounded-xl text-sm font-medium transition-all whitespace-nowrap ${kind === k.value
                                    ? 'bg-white text-black shadow-lg shadow-white/10'
                                    : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white'}`}
                            >
                                {k.label}
                            </button>
                        ))}
                    </div>
                    <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={showSettled}
                            onChange={e => setShowSettled(e.target.checked)}
                            className="accent-violet-500 w-4 h-4"
                        />
                        Show fully paid listings{hiddenCount > 0 && !showSettled ? ` (${hiddenCount})` : ''}
                    </label>
                </div>

                {error && <p role="alert" className="text-red-400 text-sm mb-4">{error}</p>}

                <div className="bg-white/[0.02] backdrop-blur-sm border border-white/[0.08] rounded-2xl overflow-hidden">
                    {loading && !data ? (
                        <div className="p-12 text-center text-gray-300">Working out who is owed…</div>
                    ) : rows.length === 0 ? (
                        <div className="p-12 text-center">
                            <p className="text-white font-medium mb-1">Nobody is waiting to be paid</p>
                            <p className="text-gray-400 text-sm">
                                Listings appear here once a guest pays for a booking or a ticket.
                            </p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-left min-w-[960px]">
                                <thead className="bg-white/[0.02] border-b border-white/[0.05]">
                                    <tr className="text-xs font-semibold text-gray-300">
                                        <th className="px-5 py-4">Listing</th>
                                        <th className="px-5 py-4">Owner</th>
                                        <th className="px-5 py-4 text-right">Owner&apos;s share</th>
                                        <th className="px-5 py-4 text-right">Paid out</th>
                                        <th className="px-5 py-4 text-right">Ready to pay</th>
                                        <th className="px-5 py-4 text-right">Upcoming</th>
                                        <th className="px-5 py-4">Pay to</th>
                                        <th className="px-5 py-4"><span className="sr-only">Action</span></th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/[0.05]">
                                    {rows.map(row => <PayoutRow key={`${row.kind}-${row.id}`} row={row} />)}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
                {data?.generatedAt && (
                    <p className="text-xs text-gray-500 mt-3">Worked out {formatDateTime(data.generatedAt)}.</p>
                )}
            </FadeIn>
        </div>
    );
}

function PayoutRow({ row }) {
    const listing = (
        <td className="px-5 py-4 align-top">
            <Link to={detailPath(row)} className="text-white font-medium hover:text-violet-300">{row.name || 'Untitled'}</Link>
            <div className="flex items-center gap-2 mt-1">
                <span className={`text-[11px] px-2 py-0.5 rounded-full border ${row.kind === 'venue'
                    ? 'bg-sky-500/10 text-sky-300 border-sky-500/20'
                    : 'bg-pink-500/10 text-pink-300 border-pink-500/20'}`}
                >
                    {row.kind === 'venue' ? 'Venue' : 'Event'}
                </span>
                {row.deleted && <span className="text-[11px] text-gray-500">Deleted listing</span>}
            </div>
        </td>
    );
    const owner = (
        <td className="px-5 py-4 align-top">
            {row.owner ? (
                <>
                    <Link to={`/users/${row.owner.id}`} className="text-gray-200 text-sm hover:text-white">{row.owner.name || 'Unnamed'}</Link>
                    <div className="text-xs text-gray-500 break-all">{row.owner.email}</div>
                </>
            ) : <span className="text-sm text-gray-500">No owner</span>}
        </td>
    );

    if (row.error) {
        return (
            <tr className="bg-red-500/[0.04]">
                {listing}
                {owner}
                <td colSpan={5} className="px-5 py-4 text-sm text-red-300">
                    {row.error}. Open the listing to see why before paying anything.
                </td>
                <td className="px-5 py-4 align-top text-right">
                    <Link to={detailPath(row)} className="text-sm text-violet-400 hover:text-violet-300">Open</Link>
                </td>
            </tr>
        );
    }

    const m = row.money;
    const owed = m.outstandingAmount > 0.01;
    return (
        <tr className="hover:bg-white/[0.02]">
            {listing}
            {owner}
            <td className="px-5 py-4 align-top text-right tabular-nums text-sm text-gray-200">{formatInr(m.netPayable)}</td>
            <td className="px-5 py-4 align-top text-right tabular-nums text-sm text-gray-400">
                {formatInr(m.settledToDate)}
                {m.excessAmount > 0.01 && <div className="text-xs text-red-300">Overpaid {formatInr(m.excessAmount)}</div>}
            </td>
            <td className={`px-5 py-4 align-top text-right tabular-nums text-sm font-semibold ${m.dueNow > 0.01 ? 'text-green-300' : 'text-gray-500'}`}>
                {formatInr(m.dueNow)}
            </td>
            <td className="px-5 py-4 align-top text-right tabular-nums text-sm text-gray-400">{formatInr(m.upcoming)}</td>
            <td className="px-5 py-4 align-top text-sm">
                {row.blockedReason ? (
                    <BlockedNote row={row} />
                ) : row.payTo ? (
                    <div>
                        <div className="text-gray-200">{row.payTo.bankName} <span className="tabular-nums">{row.payTo.accountNumber}</span></div>
                        <div className="text-xs text-gray-500">{row.payTo.accountName} · {row.payTo.ifscCode}</div>
                    </div>
                ) : null}
            </td>
            <td className="px-5 py-4 align-top text-right">
                {owed ? (
                    <Link
                        to={detailPath(row)}
                        className="inline-block px-3 py-1.5 rounded-lg bg-violet-500/90 hover:bg-violet-500 text-white text-sm font-medium whitespace-nowrap"
                    >
                        Pay
                    </Link>
                ) : (
                    <Link to={detailPath(row)} className="text-sm text-gray-400 hover:text-white whitespace-nowrap">View</Link>
                )}
            </td>
        </tr>
    );
}

function BlockedNote({ row }) {
    const fix = row.blockedReason === 'PAN not verified'
        ? (row.idCheck?.status === 'pending'
            ? <Link to="/id-checks" className="text-violet-400 hover:text-violet-300">Review in ID Checks</Link>
            : 'The organiser needs to add their PAN in Settings')
        : row.blockedReason === 'No bank account saved'
            ? 'Ask the owner to add a payout account in Settings'
            : null;
    return (
        <div>
            <div className="text-amber-300 font-medium">{row.blockedReason}</div>
            {fix && <div className="text-xs text-gray-400 mt-0.5">{fix}</div>}
        </div>
    );
}
