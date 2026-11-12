import { useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Search box that searches on Enter (or the button) and clears with ✕.
 *
 * It keeps its own draft text so typing does not fire a request per keystroke;
 * `value` is the applied search, `onSearch` receives the new one. When `value`
 * changes from outside (e.g. Back restores an older URL), the draft follows.
 */
export function SearchInput({ value = '', onSearch, placeholder = 'Search…', className = '', label = 'Search' }) {
    const [draft, setDraft] = useState(value);
    // Follow an outside change of `value` (React's "adjust state during render"
    // pattern, rather than an effect that would render twice).
    const [seenValue, setSeenValue] = useState(value);
    if (value !== seenValue) {
        setSeenValue(value);
        setDraft(value);
    }

    const submit = (e) => {
        e.preventDefault();
        onSearch(draft.trim());
    };

    return (
        <form role="search" onSubmit={submit} className={cn('relative w-full sm:max-w-xs', className)}>
            <label className="sr-only" htmlFor="admin-search">{label}</label>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" aria-hidden="true" />
            <input
                id="admin-search"
                type="search"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={placeholder}
                className="h-10 w-full rounded-xl border border-line bg-surface pl-9 pr-9 text-sm text-white placeholder-gray-500 transition-colors focus:border-violet-500/60 focus:outline-none focus:ring-2 focus:ring-violet-500/30 [&::-webkit-search-cancel-button]:hidden"
            />
            {(draft || value) && (
                <button
                    type="button"
                    onClick={() => { setDraft(''); onSearch(''); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-gray-500 hover:bg-hover hover:text-white"
                    aria-label="Clear search"
                >
                    <X className="h-4 w-4" aria-hidden="true" />
                </button>
            )}
        </form>
    );
}
