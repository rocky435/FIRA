'use client';

import { useEffect } from 'react';
import { useIdentity } from '@/hooks/useIdentity';
import { IdentityStatusPill, PanForm } from './IdentitySection';

/**
 * The organiser's PAN, asked for once, at the payout step of their first event.
 *
 * Ticket earnings are paid out only after an admin verifies it, so it is asked
 * for here, next to the bank account, rather than discovered at payout time.
 * Submitted (still under review) is enough to publish; `onReadyChange` reports
 * that so the step can block until then.
 */
export default function EventPanStep({ onReadyChange, error }: {
    onReadyChange: (ready: boolean) => void;
    error?: string;
}) {
    const { identity, isLoading, submitPan } = useIdentity();
    const status = identity?.pan.status ?? 'none';
    const ready = status === 'pending' || status === 'verified';

    useEffect(() => {
        if (!isLoading) onReadyChange(ready);
    }, [isLoading, ready, onReadyChange]);

    if (isLoading) return null;

    if (ready) {
        return (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex items-start justify-between gap-3">
                <div>
                    <p className="text-white font-medium">PAN</p>
                    <p className="text-sm text-gray-400 mt-0.5">
                        {status === 'verified'
                            ? 'Verified. Your earnings can be paid out.'
                            : 'Under review. You can publish now; payouts start once it is verified.'}
                    </p>
                </div>
                <IdentityStatusPill status={status} />
            </div>
        );
    }

    return (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-4">
            <div>
                <div className="flex items-center justify-between gap-3">
                    <h4 className="text-white font-medium">Add your PAN</h4>
                    <IdentityStatusPill status={status} />
                </div>
                <p className="text-sm text-gray-400 mt-1">
                    Needed once, so we can pay out your ticket earnings. Our team checks it.
                </p>
                {status === 'rejected' && identity?.pan.rejectionReason && (
                    <p className="text-sm text-red-300 mt-1">Not accepted: {identity.pan.rejectionReason}</p>
                )}
            </div>
            <PanForm submitLabel="Save PAN" onSubmit={submitPan} />
            {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        </div>
    );
}
