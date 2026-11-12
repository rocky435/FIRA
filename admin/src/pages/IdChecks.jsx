import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, ShieldCheck, Info } from 'lucide-react';
import adminApi from '../api/adminApi';
import { useRemote } from '../lib/useRemote';
import { cn } from '../lib/cn';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorState, TableSkeleton } from '../components/ui/States';
import IdentityReview from '../components/IdentityReview';

/**
 * Everyone waiting for an identity decision: venue owners' government IDs
 * (a venue cannot be approved until its owner's is verified) and organisers'
 * PANs (event earnings cannot be paid out until it is verified).
 *
 * Document links expire after 10 minutes, so "Refresh" re-issues them.
 */
export default function IdChecks() {
    const load = useCallback(() => adminApi.getIdentityChecks(), []);
    const { data, loading, refreshing, error, reload } = useRemote(load);
    // A decided user stays on screen with their new status until the next
    // refresh, so the admin sees the result of what they just clicked.
    const [decided, setDecided] = useState({});
    const users = (data?.users || []).map((u) => decided[String(u._id)] || u);
    const refresh = () => { setDecided({}); reload(); };
    const replace = (updated) => setDecided((prev) => ({ ...prev, [String(updated._id)]: updated }));

    const waiting = users.filter((u) => u.govId?.status === 'pending' || u.pan?.status === 'pending').length;

    return (
        <div className="p-4 sm:p-6 lg:p-8">
            <PageHeader
                title="ID Checks"
                description="Check each photo against the number before verifying."
                count={loading ? null : waiting}
                actions={(
                    <Button variant="secondary" onClick={refresh} isLoading={refreshing} disabled={loading} leftIcon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}>
                        Refresh
                    </Button>
                )}
            />

            <div className="mb-6 flex items-start gap-3 rounded-xl border border-line bg-surface p-4 text-sm text-gray-300">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" aria-hidden="true" />
                <div className="space-y-1">
                    <p><span className="font-medium text-white">Government ID</span>: venue owners. Their venues can be approved only after this is verified.</p>
                    <p><span className="font-medium text-white">PAN</span>: event organisers. Their ticket earnings can be paid out only after this is verified.</p>
                    <p className="text-gray-400">Verify only when the photo is clear, the number matches, and the name matches the account and its bank account. Photo links work for 10 minutes; Refresh gets new ones.</p>
                </div>
            </div>

            <Card padded={false} aria-busy={loading || refreshing || undefined} className={cn('overflow-hidden transition-opacity', refreshing && 'opacity-60')}>
                {error ? (
                    <ErrorState title="Couldn't load ID checks" message={error} onRetry={refresh} />
                ) : loading ? (
                    <TableSkeleton rows={3} columns={2} />
                ) : users.length === 0 ? (
                    <EmptyState icon={ShieldCheck} title="Nothing waiting for review" message="New government IDs and PANs appear here as people submit them." />
                ) : (
                    <ul className="divide-y divide-line">
                        {users.map((u) => (
                            <li key={u._id} className="space-y-3 px-5 py-5">
                                <div>
                                    <Link to={`/users/${u._id}`} className="text-sm font-semibold text-white hover:text-violet-300">{u.name || 'Unnamed'}</Link>
                                    <p className="break-all text-xs text-gray-400">{u.email}</p>
                                </div>
                                <IdentityReview
                                    identity={u}
                                    onChange={replace}
                                    only={u.govId?.status === 'none' ? 'pan' : u.pan?.status === 'none' ? 'gov-id' : undefined}
                                />
                            </li>
                        ))}
                    </ul>
                )}
            </Card>
        </div>
    );
}
