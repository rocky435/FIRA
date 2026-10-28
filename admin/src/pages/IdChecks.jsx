import { useCallback, useEffect, useState } from 'react';
import adminApi from '../api/adminApi';
import { FadeIn } from '../components/animations';
import IdentityReview from '../components/IdentityReview';

/**
 * Everyone waiting for an identity decision: venue owners' government IDs
 * (a venue cannot be approved until its owner's is verified) and organisers'
 * PANs (event earnings cannot be paid out until it is verified).
 *
 * Document links expire after 10 minutes, so "Refresh" re-issues them.
 */
export default function IdChecks() {
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const data = await adminApi.getIdentityChecks();
            setUsers(data?.users || []);
        } catch (err) {
            setError(err.message || 'Failed to load ID checks');
            setUsers([]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    // Keep a decided user on screen with their new status until the next refresh,
    // so the admin sees the result of what they just clicked.
    const replace = (updated) => setUsers(list => list.map(u => (String(u._id) === String(updated._id) ? updated : u)));

    const waiting = users.filter(u => u.govId?.status === 'pending' || u.pan?.status === 'pending').length;

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <FadeIn>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
                    <div>
                        <h1 className="text-3xl font-bold text-white mb-2">ID Checks</h1>
                        <div className="flex items-center gap-2 text-gray-300 flex-wrap">
                            <span>Check each photo against the number before verifying</span>
                            <span className="w-1 h-1 rounded-full bg-gray-600"></span>
                            <span>{waiting} waiting</span>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={load}
                        disabled={loading}
                        className="px-4 py-2 rounded-lg bg-white/[0.08] text-white text-sm hover:bg-white/[0.14] transition-colors disabled:opacity-50"
                    >
                        {loading ? 'Loading…' : 'Refresh'}
                    </button>
                </div>

                <div className="bg-white/[0.02] border border-white/[0.08] rounded-2xl p-4 mb-6 text-sm text-gray-300 space-y-1">
                    <p><span className="text-white font-medium">Government ID</span>: venue owners. Their venues can be approved only after this is verified.</p>
                    <p><span className="text-white font-medium">PAN</span>: event organisers. Their ticket earnings can be paid out only after this is verified.</p>
                    <p className="text-gray-400">Verify only when the photo is clear, the number matches, and the name matches the account and its bank account.</p>
                </div>

                {error && <p role="alert" className="text-red-400 text-sm mb-4">{error}</p>}

                <div className="bg-white/[0.02] backdrop-blur-sm border border-white/[0.08] rounded-2xl overflow-hidden">
                    {loading ? (
                        <div className="p-12 text-center text-gray-300">Loading ID checks…</div>
                    ) : users.length === 0 ? (
                        <div className="p-12 text-center">
                            <div className="flex flex-col items-center gap-2">
                                <span className="text-2xl">✅</span>
                                <span className="text-gray-300">Nothing waiting for review</span>
                            </div>
                        </div>
                    ) : (
                        <div className="divide-y divide-white/[0.05]">
                            {users.map(u => (
                                <div key={u._id} className="px-6 py-5 space-y-3">
                                    <div>
                                        <p className="text-white font-semibold text-sm">{u.name || 'Unnamed'}</p>
                                        <p className="text-gray-400 text-xs break-all">{u.email}</p>
                                    </div>
                                    <IdentityReview
                                        identity={u}
                                        onChange={replace}
                                        only={u.govId?.status === 'none' ? 'pan' : u.pan?.status === 'none' ? 'gov-id' : undefined}
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </FadeIn>
        </div>
    );
}
