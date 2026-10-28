'use client';

import { useCallback, useEffect, useState } from 'react';
import { usersApi, uploadApi, type Identity } from '@/lib/api';

type SubmitResult = { ok: true } | { ok: false; error: string; field?: string };

/**
 * The signed-in user's identity checks (government ID, PAN) and submitting them.
 *
 * Shared by Settings and the event payout step so both show the same status.
 * Photos go to the private gov-ids folder; only admins can open them.
 */
export function useIdentity() {
    const [identity, setIdentity] = useState<Identity | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const load = useCallback(async () => {
        try {
            setIsLoading(true);
            setIdentity(await usersApi.getIdentity());
        } catch {
            setIdentity(null);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const toResult = (err: unknown): SubmitResult => {
        const e = err as { message?: string; field?: string };
        return { ok: false, error: e?.message || 'Could not save', field: e?.field };
    };

    const submitPan = async (panNumber: string, photo: File): Promise<SubmitResult> => {
        try {
            const { url } = await uploadApi.single(photo, 'gov-ids');
            setIdentity(await usersApi.submitPan({ panNumber, panDocument: url }));
            return { ok: true };
        } catch (err) {
            return toResult(err);
        }
    };

    const submitGovId = async (govIdType: string, govIdNumber: string, photo: File): Promise<SubmitResult> => {
        try {
            const { url } = await uploadApi.single(photo, 'gov-ids');
            setIdentity(await usersApi.submitGovId({ govIdType, govIdNumber, govIdDocument: url }));
            return { ok: true };
        } catch (err) {
            return toResult(err);
        }
    };

    return { identity, isLoading, reload: load, submitPan, submitGovId };
}
