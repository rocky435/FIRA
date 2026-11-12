import { useId, useState } from 'react';
import { ExternalLink, IdCard, ShieldCheck, X } from 'lucide-react';
import adminApi from '../api/adminApi';
import { StatusBadge } from './ui/StatusBadge';
import { Button } from './ui/Button';
import { useToast } from './ui/toastContext';

const STATUS_LABEL = { verified: 'Verified', pending: 'Waiting for review', rejected: 'Rejected', none: 'Not submitted' };

export function IdentityStatusBadge({ status }) {
    return <StatusBadge value={status || 'none'}>{STATUS_LABEL[status] || status || STATUS_LABEL.none}</StatusBadge>;
}

/**
 * One check (government ID or PAN): the number, a link to the photo, and the
 * verify / reject decision. Rejecting asks for the reason, which the user is
 * shown and notified about.
 */
function Check({ userId, kind, title, detail, onReviewed }) {
    const toast = useToast();
    const reasonId = useId();
    const [rejecting, setRejecting] = useState(false);
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState('');

    const decide = async (action) => {
        if (action === 'reject' && !reason.trim()) {
            setError('Write the reason - the user sees it.');
            return;
        }
        setBusy(action);
        setError('');
        try {
            const updated = await adminApi.reviewIdentity(userId, kind, action, reason.trim());
            setRejecting(false);
            setReason('');
            toast.success(action === 'verify' ? `${title} verified` : `${title} rejected. The user is notified.`);
            onReviewed?.(updated);
        } catch (err) {
            setError(err?.message || 'Could not save the decision');
        } finally {
            setBusy(null);
        }
    };

    const submitted = detail.status !== 'none';
    return (
        <div className="space-y-2.5 rounded-xl border border-line bg-surface-raised p-3.5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-gray-400">
                    <IdCard className="h-3.5 w-3.5" aria-hidden="true" />
                    {title}
                </p>
                <IdentityStatusBadge status={detail.status} />
            </div>

            {submitted ? (
                <>
                    <p className="break-all text-gray-200">
                        {detail.type ? <span className="text-gray-400">{detail.type.replace(/_/g, ' ')}: </span> : null}
                        <span className="font-mono">{detail.number || '—'}</span>
                    </p>
                    {detail.documentUrl
                        ? (
                            <a href={detail.documentUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-violet-300 hover:text-violet-200">
                                Open photo <ExternalLink className="h-3 w-3" aria-hidden="true" /> <span className="text-gray-500">(link works for 10 minutes)</span>
                            </a>
                        )
                        : <p className="text-xs text-gray-500">No photo uploaded</p>}
                    {detail.status === 'rejected' && detail.rejectionReason && (
                        <p className="text-xs text-red-300">Rejected: {detail.rejectionReason}</p>
                    )}
                </>
            ) : (
                <p className="text-xs text-gray-500">Nothing submitted yet.</p>
            )}

            {submitted && !rejecting && (
                <div className="flex flex-wrap gap-2 pt-1">
                    {detail.status !== 'verified' && (
                        <Button size="sm" variant="success" onClick={() => decide('verify')} isLoading={busy === 'verify'} disabled={Boolean(busy)} leftIcon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}>
                            Mark verified
                        </Button>
                    )}
                    {detail.status !== 'rejected' && (
                        <Button size="sm" variant="secondary" onClick={() => { setRejecting(true); setError(''); }} disabled={Boolean(busy)} leftIcon={<X className="h-4 w-4" aria-hidden="true" />}>
                            Reject
                        </Button>
                    )}
                </div>
            )}

            {rejecting && (
                <div className="space-y-2 pt-1">
                    <label htmlFor={reasonId} className="block text-xs font-medium text-gray-300">Reason (shown to the user)</label>
                    <textarea
                        id={reasonId}
                        value={reason}
                        onChange={(e) => { setReason(e.target.value); setError(''); }}
                        maxLength={500}
                        rows={2}
                        autoFocus
                        placeholder="e.g. Photo is blurry, name does not match"
                        className="w-full resize-none rounded-xl border border-line bg-surface px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-violet-500/60 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                    />
                    <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="danger" onClick={() => decide('reject')} isLoading={busy === 'reject'}>
                            Reject and notify user
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => { setRejecting(false); setReason(''); setError(''); }} disabled={Boolean(busy)}>
                            Cancel
                        </Button>
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
            setState({ status: 'error', data: null, error: err?.message || 'Failed to load' });
        }
    };
    if (state.status === 'idle' || state.status === 'loading') {
        return (
            <Button size="sm" variant="secondary" onClick={load} isLoading={state.status === 'loading'} leftIcon={<IdCard className="h-4 w-4" aria-hidden="true" />}>
                Show ID and PAN
            </Button>
        );
    }
    if (state.status === 'error') {
        return (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
                <span className="text-red-400">{state.error}</span>
                <Button size="sm" variant="ghost" onClick={load}>Try again</Button>
            </div>
        );
    }
    return (
        <IdentityReview
            identity={state.data}
            onChange={(updated) => { setState({ status: 'done', data: updated, error: null }); onChange?.(updated); }}
        />
    );
}
