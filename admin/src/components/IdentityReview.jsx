import { useState } from 'react';
import adminApi from '../api/adminApi';

const STATUS_STYLE = {
    verified: 'bg-green-500/20 text-green-400 border-green-500/30',
    pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    rejected: 'bg-red-500/20 text-red-400 border-red-500/30',
    none: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
};
const STATUS_LABEL = { verified: 'Verified', pending: 'Waiting for review', rejected: 'Rejected', none: 'Not submitted' };

export function IdentityStatusBadge({ status }) {
    return (
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_STYLE[status] || STATUS_STYLE.none}`}>
            {STATUS_LABEL[status] || status}
        </span>
    );
}

/**
 * One check (government ID or PAN): the number, a link to the photo, and the
 * verify / reject decision. Rejecting asks for the reason, which the user is
 * shown and notified about.
 */
function Check({ userId, kind, title, detail, onReviewed }) {
    const [rejecting, setRejecting] = useState(false);
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const decide = async (action) => {
        if (action === 'reject' && !reason.trim()) {
            setError('Write the reason - the user sees it.');
            return;
        }
        setBusy(true);
        setError('');
        try {
            const updated = await adminApi.reviewIdentity(userId, kind, action, reason.trim());
            setRejecting(false);
            setReason('');
            onReviewed?.(updated);
        } catch (err) {
            setError(err.message || 'Could not save the decision');
        } finally {
            setBusy(false);
        }
    };

    const submitted = detail.status !== 'none';
    return (
        <div className="bg-white/[0.03] rounded-xl p-3 border border-white/[0.06] text-sm space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-gray-400 text-[11px] uppercase tracking-wide font-semibold">{title}</p>
                <IdentityStatusBadge status={detail.status} />
            </div>

            {submitted ? (
                <>
                    <p className="text-gray-200 break-all">
                        {detail.type ? `${detail.type.replace('_', ' ')}: ` : ''}{detail.number || '—'}
                    </p>
                    {detail.documentUrl
                        ? <a href={detail.documentUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-violet-400 hover:text-violet-300">Open photo (link works for 10 minutes)</a>
                        : <p className="text-xs text-gray-500">No photo uploaded</p>}
                    {detail.status === 'rejected' && detail.rejectionReason && (
                        <p className="text-xs text-red-300">Rejected: {detail.rejectionReason}</p>
                    )}
                </>
            ) : (
                <p className="text-gray-500 text-xs">Nothing submitted yet.</p>
            )}

            {submitted && !rejecting && (
                <div className="flex gap-2 pt-1">
                    {detail.status !== 'verified' && (
                        <button type="button" disabled={busy} onClick={() => decide('verify')}
                            className="text-xs px-3 py-1.5 rounded-lg bg-green-500/15 border border-green-500/30 text-green-300 hover:bg-green-500/25 disabled:opacity-50">
                            {busy ? 'Saving…' : 'Mark verified'}
                        </button>
                    )}
                    {detail.status !== 'rejected' && (
                        <button type="button" disabled={busy} onClick={() => { setRejecting(true); setError(''); }}
                            className="text-xs px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 disabled:opacity-50">
                            Reject
                        </button>
                    )}
                </div>
            )}

            {rejecting && (
                <div className="space-y-2 pt-1">
                    <textarea
                        value={reason}
                        onChange={(e) => { setReason(e.target.value); setError(''); }}
                        maxLength={500}
                        rows={2}
                        placeholder="Why? e.g. Photo is blurry, name does not match"
                        className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.1] text-white text-xs placeholder-gray-500 focus:outline-none focus:border-white/25"
                    />
                    <div className="flex gap-2">
                        <button type="button" disabled={busy} onClick={() => decide('reject')}
                            className="text-xs px-3 py-1.5 rounded-lg bg-red-500/20 border border-red-500/40 text-red-200 hover:bg-red-500/30 disabled:opacity-50">
                            {busy ? 'Saving…' : 'Reject and notify user'}
                        </button>
                        <button type="button" disabled={busy} onClick={() => { setRejecting(false); setReason(''); setError(''); }}
                            className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10">
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
        </div>
    );
}

/**
 * A user's government ID and PAN with review controls. Pass `identity` (from
 * getIdentityChecks / getGovId) and get the updated one back in `onChange`.
 * `only` limits it to one check.
 */
export default function IdentityReview({ identity, onChange, only }) {
    if (!identity) return null;
    const showGov = !only || only === 'gov-id';
    const showPan = !only || only === 'pan';
    return (
        <div className={`grid gap-3 ${showGov && showPan ? 'sm:grid-cols-2' : ''}`}>
            {showGov && identity.govId && (
                <Check userId={identity._id} kind="gov-id" title="Government ID (venue owner)" detail={identity.govId} onReviewed={onChange} />
            )}
            {showPan && identity.pan && (
                <Check userId={identity._id} kind="pan" title="PAN (event organiser)" detail={identity.pan} onReviewed={onChange} />
            )}
        </div>
    );
}

/** Loads one user's identity on demand (the document links expire), then shows it. */
export function IdentityReviewLoader({ userId, onChange }) {
    const [state, setState] = useState({ status: 'idle', data: null, error: null });
    const load = async () => {
        setState({ status: 'loading', data: null, error: null });
        try {
            setState({ status: 'done', data: await adminApi.getGovId(userId), error: null });
        } catch (err) {
            setState({ status: 'error', data: null, error: err.message || 'Failed to load' });
        }
    };
    if (state.status === 'idle' || state.status === 'loading') {
        return (
            <button type="button" onClick={load} disabled={state.status === 'loading'}
                className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-gray-200 hover:bg-white/10">
                {state.status === 'loading' ? 'Loading…' : 'Show ID and PAN'}
            </button>
        );
    }
    if (state.status === 'error') return <p className="text-xs text-red-400">{state.error}</p>;
    return (
        <IdentityReview
            identity={state.data}
            onChange={(updated) => { setState({ status: 'done', data: updated, error: null }); onChange?.(updated); }}
        />
    );
}
