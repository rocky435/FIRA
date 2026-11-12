import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * A list page's filter, search and page number, kept in the URL.
 *
 * They used to live in component state, so Back, a refresh or a shared link
 * dropped you on page 1 of "All" every time. Defaults are left out of the URL,
 * so an unfiltered list keeps a clean `/users` address and old bookmarks still
 * work.
 *
 *   const { params, set } = useListParams({ status: 'all', q: '', page: 1 });
 *   set({ status: 'blocked' })   // also resets page to 1
 *   set({ page: 3 })
 *
 * Changing anything other than `page` goes back to page 1, because page 3 of the
 * old filter means nothing under a new one.
 */
export function useListParams(initialDefaults) {
    const [searchParams, setSearchParams] = useSearchParams();
    // Call sites pass a fresh literal each render; key on its content so the
    // memo and callback below stay stable.
    const defaultsKey = JSON.stringify(initialDefaults);

    const params = useMemo(() => {
        const defaults = JSON.parse(defaultsKey);
        const out = {};
        for (const [key, fallback] of Object.entries(defaults)) {
            const raw = searchParams.get(key);
            if (raw == null || raw === '') {
                out[key] = fallback;
            } else if (typeof fallback === 'number') {
                const n = parseInt(raw, 10);
                out[key] = Number.isFinite(n) && n > 0 ? n : fallback;
            } else {
                out[key] = raw;
            }
        }
        return out;
    }, [searchParams, defaultsKey]);

    const set = useCallback((changes) => {
        const defaults = JSON.parse(defaultsKey);
        setSearchParams(() => {
            // Start from the address bar, not the `prev` React Router hands us:
            // that is the last *rendered* query, and navigations render as a
            // transition. Clicking "All" and then quickly searching used to build
            // the search on the pre-click query and bring the old filter back.
            const next = new URLSearchParams(window.location.search);
            const touchesFilter = Object.keys(changes).some((k) => k !== 'page');
            const merged = { ...changes };
            if (touchesFilter && !('page' in changes) && 'page' in defaults) merged.page = defaults.page;
            for (const [key, value] of Object.entries(merged)) {
                if (value == null || value === '' || value === defaults[key]) next.delete(key);
                else next.set(key, String(value));
            }
            return next;
        });
    }, [setSearchParams, defaultsKey]);

    return { params, set };
}
