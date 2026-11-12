import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Load data for a page, with loading / error / reload handled once.
 *
 *   const load = useCallback(() => adminApi.getUsers(query), [query...]);
 *   const { data, error, loading, refreshing, reload } = useRemote(load);
 *
 * - A new `load` (its inputs changed) or reload() starts a new request.
 * - A slower, older response can never overwrite a newer one: each response is
 *   only kept if it belongs to the latest request. Switching filters quickly
 *   used to let page 1's late answer land on top of page 2.
 * - `loading` is true until the first answer; `refreshing` is true while a
 *   newer request is in flight and the previous data is still on screen, so a
 *   table can dim instead of flashing to a skeleton after every action.
 */
export function useRemote(load) {
    const [nonce, setNonce] = useState(0);
    const request = useMemo(() => ({ load, nonce }), [load, nonce]);
    const [result, setResult] = useState({ request: null, data: undefined, error: null });

    useEffect(() => {
        let live = true;
        Promise.resolve()
            .then(() => request.load())
            .then(
                (data) => { if (live) setResult({ request, data, error: null }); },
                (err) => { if (live) setResult((prev) => ({ request, data: prev.data, error: err?.message || 'Something went wrong' })); }
            );
        return () => { live = false; };
    }, [request]);

    const reload = useCallback(() => setNonce((n) => n + 1), []);
    const pending = result.request !== request;
    const hasData = result.data !== undefined;

    return {
        data: result.data,
        error: pending ? null : result.error,
        loading: pending && !hasData,
        refreshing: pending && hasData,
        reload,
    };
}
