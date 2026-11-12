import { useState } from 'react';
import { useConfirm } from '../components/ui/confirmContext';
import { useToast } from '../components/ui/toastContext';

/**
 * Runs one admin call per selected row, after a confirm, then reports and reloads.
 *
 * Every list page used to carry its own copy of this loop with a window.confirm in
 * front and an alert() behind. Calls run one at a time, never in parallel.
 *
 *   const { busy, run } = useBulkRunner({ bulk, reload, noun: ['venue', 'venues'] });
 *   run({ verb: 'Approve', past: 'Approved', fn: (id) => api.approve(id) });
 *
 * `continueOnError`: carry on past a refused row (e.g. a venue whose owner's ID
 * is not verified) and list what was refused at the end. Without it the batch
 * stops at the first failure, so a broken call is not fired at every row blind.
 */
export function useBulkRunner({ bulk, reload, noun }) {
    const confirm = useConfirm();
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const [one, many] = noun;

    const run = async ({ verb, past, fn, danger, message, requireText, continueOnError = false }) => {
        const ids = [...bulk.selectedIds];
        const n = ids.length;
        if (n === 0) return;
        const word = n === 1 ? one : many;
        const ok = await confirm({
            title: `${verb} ${n} selected ${word}?`,
            message,
            confirmLabel: `${verb} ${n} ${word}`,
            tone: danger ? 'danger' : undefined,
            requireText,
        });
        if (!ok) return;

        setBusy(true);
        let done = 0;
        const failures = [];
        try {
            for (const id of ids) {
                try {
                    await fn(id);
                    done += 1;
                } catch (err) {
                    failures.push(err?.message || 'failed');
                    if (!continueOnError) break;
                }
            }
        } finally {
            if (failures.length === 0) bulk.clear();
            await reload();
            setBusy(false);
        }

        if (failures.length === 0) {
            toast.success(`${past} ${done} ${done === 1 ? one : many}`);
        } else if (continueOnError) {
            const left = failures.length;
            // Repeated reasons ("owner ID not verified" ×3) read once.
            const reasons = [...new Set(failures)].join(' · ');
            toast.error(`${done} done, ${left} ${left === 1 ? one : many} not done: ${reasons}`);
        } else {
            toast.error(`${failures[0]} (${done} of ${n} done)`);
        }
    };

    return { busy, run };
}
