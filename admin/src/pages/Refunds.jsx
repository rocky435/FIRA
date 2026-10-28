import { useState, useEffect, useCallback } from 'react';
import adminApi from '../api/adminApi';
import { FadeIn } from '../components/animations';
import { Pagination } from '../components/ui/Pagination';

const PAGE_SIZE = 20;

// "Refunds to be done": every customer refund (booking rejected or cancelled,
// event removed, venue removed) is raised as a pending request and waits here.
// Refunds are paid manually - from the Razorpay dashboard or by bank transfer -
// and then marked as refunded here with the reference they were paid under.
const TABS = [
    { key: 'pending', label: 'To be done' },
    { key: 'completed', label: 'Refunded' },
    { key: 'rejected', label: 'Rejected' },
    { key: '', label: 'All' },
];

const REASON_LABELS = {
    event_cancelled: 'Event cancelled',
    booking_cancelled: 'Booking cancelled',
    user_request: 'Ticket cancelled',
    duplicate_payment: 'Duplicate payment',
    admin_initiated: 'Admin initiated',
    other: 'Other',
};

const STATUS_STYLES = {
    pending: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30',
    processing: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
    completed: 'bg-green-500/15 text-green-300 border-green-500/30',
    rejected: 'bg-gray-500/15 text-gray-300 border-gray-500/30',
    failed: 'bg-red-500/15 text-red-300 border-red-500/30',
};

const formatDate = (d) => {
    if (!d) return 'N/A';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return 'Invalid';
    return dt.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const formatCurrency = (amount) =>
    `₹${(Number(amount) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export default function Refunds() {
    const [status, setStatus] = useState('pending');
    const [page, setPage] = useState(1);
    const [data, setData] = useState({ refunds: [], totalPages: 1, total: 0 });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [busyId, setBusyId] = useState(null);
    const [rejectingId, setRejectingId] = useState(null);
    const [rejectReason, setRejectReason] = useState('');
    const [payingId, setPayingId] = useState(null);
    const [reference, setReference] = useState('');
    const [rowError, setRowError] = useState({});

    const fetchRefunds = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const params = { page, limit: PAGE_SIZE };
            if (status) params.status = status;
            const result = await adminApi.getRefunds(params);
            setData({
                refunds: result?.refunds || [],
                totalPages: result?.totalPages || 1,
                total: result?.total || 0,
            });
        } catch (err) {
            setError(err.message || 'Failed to load refunds');
            setData({ refunds: [], totalPages: 1, total: 0 });
        } finally {
            setLoading(false);
        }
    }, [status, page]);

    useEffect(() => {
        fetchRefunds();
    }, [fetchRefunds]);

    const changeTab = (key) => {
        setStatus(key);
        setPage(1);
        setRejectingId(null);
    };

    // Records a refund the admin has already paid outside FIRA.
    const markRefunded = async (refund) => {
        if (!reference.trim()) {
            setRowError((prev) => ({ ...prev, [refund._id]: 'Enter the Razorpay refund ID or bank UTR you paid it under.' }));
            return;
        }
        setBusyId(refund._id);
        setRowError((prev) => ({ ...prev, [refund._id]: '' }));
        try {
            await adminApi.processRefund(refund._id, 'approve', '', reference.trim());
            setPayingId(null);
            setReference('');
            await fetchRefunds();
        } catch (err) {
            setRowError((prev) => ({ ...prev, [refund._id]: err.message || 'Approval failed' }));
        } finally {
            setBusyId(null);
        }
    };

    const reject = async (refund) => {
        const reason = rejectReason.trim();
        if (!reason) {
            setRowError((prev) => ({ ...prev, [refund._id]: 'Enter a reason - the customer will see it.' }));
            return;
        }
        setBusyId(refund._id);
        setRowError((prev) => ({ ...prev, [refund._id]: '' }));
        try {
            await adminApi.processRefund(refund._id, 'reject', reason);
            setRejectingId(null);
            setRejectReason('');
            await fetchRefunds();
        } catch (err) {
            setRowError((prev) => ({ ...prev, [refund._id]: err.message || 'Rejection failed' }));
        } finally {
            setBusyId(null);
        }
    };

    const actionable = (r) => r.status === 'pending' || r.status === 'failed';

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <FadeIn>
                <div className="mb-8">
                    <h1 className="text-3xl font-bold text-white mb-2">Refunds to be done</h1>
                    <p className="text-gray-300">
                        Pay each refund manually (Razorpay dashboard or bank transfer), then mark it as refunded here with its reference. The customer is notified.
                    </p>
                </div>

                <div className="flex flex-wrap gap-2 mb-6">
                    {TABS.map((tab) => (
                        <button
                            key={tab.key || 'all'}
                            onClick={() => changeTab(tab.key)}
                            className={`px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${
                                status === tab.key
                                    ? 'bg-white text-black border-white'
                                    : 'bg-white/[0.03] text-gray-300 border-white/[0.08] hover:bg-white/[0.06]'
                            }`}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                <div className="bg-white/[0.02] backdrop-blur-sm border border-white/[0.08] rounded-2xl overflow-hidden">
                    {loading ? (
                        <div className="p-12 text-center text-gray-300">Loading refunds...</div>
                    ) : error ? (
                        <div className="p-12 text-center text-red-300">{error}</div>
                    ) : data.refunds.length === 0 ? (
                        <div className="p-12 text-center text-gray-300">No refunds here.</div>
                    ) : (
                        <>
                            <div className="px-6 py-3 border-b border-white/[0.05] text-sm text-gray-400">
                                {data.total} refund{data.total === 1 ? '' : 's'}
                            </div>
                            <ul className="divide-y divide-white/[0.05]">
                                {data.refunds.map((r) => (
                                    <li key={r._id} className="px-6 py-5">
                                        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                                            <div className="min-w-0 space-y-1">
                                                <div className="flex flex-wrap items-center gap-3">
                                                    <span className="text-xl font-semibold text-white">{formatCurrency(r.amount)}</span>
                                                    <span className={`px-2.5 py-0.5 rounded-full text-xs border ${STATUS_STYLES[r.status] || STATUS_STYLES.rejected}`}>
                                                        {r.status}
                                                    </span>
                                                    <span className="text-sm text-gray-400">{REASON_LABELS[r.reason] || r.reason}</span>
                                                </div>
                                                <div className="text-sm text-gray-300">
                                                    {r.user?.name || 'Unknown customer'}
                                                    {r.user?.email && <span className="text-gray-500"> · {r.user.email}</span>}
                                                </div>
                                                {r.reasonDetails && <div className="text-sm text-gray-400">{r.reasonDetails}</div>}
                                                <div className="text-xs text-gray-500">
                                                    Requested {formatDate(r.requestedAt || r.createdAt)}
                                                    {r.payment && (
                                                        <> · original payment {formatCurrency(r.payment.totalAmount || r.payment.amount)} ({r.payment.type})</>
                                                    )}
                                                    {r.reviewedAt && <> · decided {formatDate(r.reviewedAt)}</>}
                                                </div>
                                                {r.status === 'completed' && r.gatewayRefundId && (
                                                    <div className="text-sm text-gray-400">Reference: {r.gatewayRefundId}</div>
                                                )}
                                                {r.status === 'rejected' && r.rejectionReason && (
                                                    <div className="text-sm text-gray-400">Rejected: {r.rejectionReason}</div>
                                                )}
                                                {rowError[r._id] && <div className="text-sm text-red-300">{rowError[r._id]}</div>}
                                            </div>

                                            {actionable(r) && (
                                                <div className="flex flex-col gap-2 lg:w-80 shrink-0">
                                                    {payingId === r._id ? (
                                                        <>
                                                            <input
                                                                autoFocus
                                                                value={reference}
                                                                onChange={(e) => setReference(e.target.value)}
                                                                placeholder="Razorpay refund ID or bank UTR"
                                                                className="w-full px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.1] text-white text-sm placeholder:text-gray-500 focus:outline-none focus:border-white/30"
                                                            />
                                                            <div className="flex gap-2">
                                                                <button
                                                                    onClick={() => markRefunded(r)}
                                                                    disabled={busyId === r._id}
                                                                    className="flex-1 px-4 py-2 rounded-xl text-sm font-medium bg-green-500/80 hover:bg-green-500 text-white disabled:opacity-50"
                                                                >
                                                                    {busyId === r._id ? 'Saving...' : 'Confirm refunded'}
                                                                </button>
                                                                <button
                                                                    onClick={() => { setPayingId(null); setReference(''); }}
                                                                    disabled={busyId === r._id}
                                                                    className="px-4 py-2 rounded-xl text-sm text-gray-300 bg-white/[0.04] hover:bg-white/[0.08]"
                                                                >
                                                                    Cancel
                                                                </button>
                                                            </div>
                                                        </>
                                                    ) : rejectingId === r._id ? (
                                                        <>
                                                            <input
                                                                autoFocus
                                                                value={rejectReason}
                                                                onChange={(e) => setRejectReason(e.target.value)}
                                                                placeholder="Reason (shown to the customer)"
                                                                className="w-full px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.1] text-white text-sm placeholder:text-gray-500 focus:outline-none focus:border-white/30"
                                                            />
                                                            <div className="flex gap-2">
                                                                <button
                                                                    onClick={() => reject(r)}
                                                                    disabled={busyId === r._id}
                                                                    className="flex-1 px-4 py-2 rounded-xl text-sm font-medium bg-red-500/80 hover:bg-red-500 text-white disabled:opacity-50"
                                                                >
                                                                    {busyId === r._id ? 'Rejecting...' : 'Confirm reject'}
                                                                </button>
                                                                <button
                                                                    onClick={() => { setRejectingId(null); setRejectReason(''); }}
                                                                    disabled={busyId === r._id}
                                                                    className="px-4 py-2 rounded-xl text-sm text-gray-300 bg-white/[0.04] hover:bg-white/[0.08]"
                                                                >
                                                                    Cancel
                                                                </button>
                                                            </div>
                                                        </>
                                                    ) : (
                                                        <div className="flex gap-2">
                                                            <button
                                                                onClick={() => { setPayingId(r._id); setReference(''); setRejectingId(null); }}
                                                                disabled={busyId === r._id}
                                                                className="flex-1 px-4 py-2 rounded-xl text-sm font-medium bg-green-500/80 hover:bg-green-500 text-white disabled:opacity-50"
                                                            >
                                                                Mark as refunded
                                                            </button>
                                                            <button
                                                                onClick={() => { setRejectingId(r._id); setRejectReason(''); setPayingId(null); }}
                                                                disabled={busyId === r._id}
                                                                className="flex-1 px-4 py-2 rounded-xl text-sm font-medium text-red-300 border border-red-500/30 hover:bg-red-500/10 disabled:opacity-50"
                                                            >
                                                                Reject
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                            <Pagination currentPage={page} totalPages={data.totalPages} onChange={setPage} />
                        </>
                    )}
                </div>
            </FadeIn>
        </div>
    );
}
