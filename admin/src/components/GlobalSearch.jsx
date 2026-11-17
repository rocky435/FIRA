import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, User, Ticket, Building2, Star, CornerDownLeft, LayoutGrid } from 'lucide-react';
import adminApi from '../api/adminApi';
import { cn } from '../lib/cn';
import { StatusBadge } from './ui/StatusBadge';

const GROUPS = [
    { key: 'pages', title: 'Pages', icon: LayoutGrid },
    { key: 'users', title: 'People', icon: User },
    { key: 'events', title: 'Events', icon: Ticket },
    { key: 'venues', title: 'Venues', icon: Building2 },
    { key: 'brands', title: 'Creators', icon: Star },
];

const formatDay = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** One result: what to show and where it goes. */
function toItem(group, r) {
    switch (group) {
        case 'pages': return { id: r.href, to: r.href, title: r.label, sub: r.group };
        case 'users': return { id: r._id, to: `/users/${r._id}`, title: r.name || 'Unnamed', sub: [r.email, r.phone].filter(Boolean).join(' · '), badge: r.isBlocked ? 'blocked' : null };
        case 'events': return { id: r._id, to: `/events/${r._id}`, title: r.name, sub: formatDay(r.startDateTime), badge: r.status };
        case 'venues': return { id: r._id, to: `/venues/${r._id}`, title: r.name, sub: r.address?.city || '', badge: r.status };
        default: return { id: r._id, to: `/brands/${r._id}`, title: r.name, sub: r.type ? r.type.charAt(0).toUpperCase() + r.type.slice(1) : '', badge: r.status };
    }
}

/**
 * The admin's one search box, in the top bar of every page: people (name, email
 * or phone), events, venues, creators, and the admin's own pages. "/" or Ctrl+K
 * jumps to it; arrows move through the results and Enter opens one.
 * On a phone it is an icon that opens a full-width search bar.
 *
 * `pages` is the menu the signed-in admin can see, as [{ href, label, group }].
 */
export default function GlobalSearch({ pages = [] }) {
    const navigate = useNavigate();
    const listId = useId();
    const inputRef = useRef(null);
    const boxRef = useRef(null);
    const [q, setQ] = useState('');
    const [open, setOpen] = useState(false);
    const [mobileOpen, setMobileOpen] = useState(false);
    // The server's answer, kept with the words it answers, so a result is only
    // shown for the text in the box and an older answer never shows for newer text.
    const [answer, setAnswer] = useState({ term: '', data: null, failed: false });
    const [active, setActive] = useState(0);

    const term = q.trim();
    const current = answer.term === term;
    const results = current ? answer.data : null;
    const failed = current && answer.failed;
    const loading = term.length >= 2 && !current;

    // Ask a moment after typing stops.
    useEffect(() => {
        if (term.length < 2) return undefined;
        let live = true;
        const t = setTimeout(() => {
            adminApi.search(term)
                .then((data) => { if (live) setAnswer({ term, data, failed: false }); })
                .catch(() => { if (live) setAnswer({ term, data: null, failed: true }); });
        }, 250);
        return () => { live = false; clearTimeout(t); };
    }, [term]);

    const groups = useMemo(() => {
        const lower = term.toLowerCase();
        const pageHits = term ? pages.filter((p) => p.label.toLowerCase().includes(lower) || p.group.toLowerCase().includes(lower)).slice(0, 4) : [];
        const source = { pages: pageHits, ...(results || {}) };
        const filled = GROUPS
            .map((g) => ({ ...g, items: (source[g.key] || []).map((r) => toItem(g.key, r)) }))
            .filter((g) => g.items.length > 0);
        // Each group's first position in the arrow-key order.
        return filled.map((g, gi) => ({ ...g, start: filled.slice(0, gi).reduce((n, prev) => n + prev.items.length, 0) }));
    }, [term, pages, results]);
    const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
    const activeIndex = active < flat.length ? active : 0;

    // "/" and Ctrl/Cmd+K focus the box from anywhere, unless typing elsewhere.
    useEffect(() => {
        const onKey = (e) => {
            const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
            if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
                e.preventDefault();
                setMobileOpen(true);
                setOpen(true);
                requestAnimationFrame(() => inputRef.current?.focus());
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);

    // Click outside closes the results.
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => { if (!boxRef.current?.contains(e.target)) { setOpen(false); setMobileOpen(false); } };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    const go = (item) => {
        navigate(item.to);
        setQ('');
        setOpen(false);
        setMobileOpen(false);
        inputRef.current?.blur();
    };

    const onKeyDown = (e) => {
        if (e.key === 'Escape') { setOpen(false); setMobileOpen(false); inputRef.current?.blur(); return; }
        if (!flat.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive((activeIndex + 1) % flat.length); }
        if (e.key === 'ArrowUp') { e.preventDefault(); setActive((activeIndex - 1 + flat.length) % flat.length); }
        if (e.key === 'Enter') { e.preventDefault(); go(flat[activeIndex]); }
    };

    const showPanel = open && term.length > 0;

    return (
        <>
            {/* Phone: an icon; the bar opens over the top bar. */}
            <button
                type="button"
                onClick={() => { setMobileOpen(true); setOpen(true); requestAnimationFrame(() => inputRef.current?.focus()); }}
                className="rounded-lg p-2 text-gray-300 hover:bg-hover hover:text-white md:hidden"
                aria-label="Search"
            >
                <Search className="h-5 w-5" aria-hidden="true" />
            </button>

            <div
                ref={boxRef}
                className={cn(
                    'md:relative md:block md:w-72 lg:w-96',
                    mobileOpen ? 'fixed inset-x-0 top-0 z-50 block border-b border-line bg-background p-3' : 'hidden'
                )}
            >
                <div className="relative flex items-center gap-2">
                    <div className="relative flex-1">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" aria-hidden="true" />
                        <input
                            ref={inputRef}
                            type="search"
                            role="combobox"
                            aria-expanded={showPanel}
                            aria-controls={listId}
                            aria-activedescendant={showPanel && flat[activeIndex] ? `${listId}-${activeIndex}` : undefined}
                            aria-label="Search people, events, venues and creators"
                            value={q}
                            onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
                            onFocus={() => setOpen(true)}
                            onKeyDown={onKeyDown}
                            placeholder="Search people, events, venues…"
                            className="h-10 w-full rounded-xl border border-line bg-surface pl-9 pr-12 text-sm text-white placeholder-gray-500 focus:border-violet-500/60 focus:outline-none focus:ring-2 focus:ring-violet-500/25"
                        />
                        {!q && <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-line px-1.5 text-[10px] text-gray-500 md:inline">/</kbd>}
                    </div>
                    {mobileOpen && (
                        <button type="button" onClick={() => { setMobileOpen(false); setOpen(false); }} className="rounded-lg p-2 text-gray-400 hover:bg-hover hover:text-white md:hidden" aria-label="Close search">
                            <X className="h-5 w-5" aria-hidden="true" />
                        </button>
                    )}
                </div>

                {showPanel && (
                    <div
                        id={listId}
                        role="listbox"
                        aria-label="Search results"
                        className="absolute inset-x-3 top-full z-50 mt-2 max-h-[70vh] overflow-y-auto rounded-xl border border-line-strong bg-surface-raised py-2 shadow-2xl md:inset-x-0"
                    >
                        {term.length < 2 && groups.length === 0 && <p className="px-4 py-3 text-sm text-gray-500">Type at least 2 letters.</p>}
                        {term.length >= 2 && loading && !results && <p className="px-4 py-3 text-sm text-gray-500">Searching…</p>}
                        {failed && <p className="px-4 py-3 text-sm text-red-300">Search failed. Try again.</p>}
                        {term.length >= 2 && !loading && !failed && groups.length === 0 && (
                            <p className="px-4 py-3 text-sm text-gray-500">Nothing found for &ldquo;{term}&rdquo;.</p>
                        )}
                        {groups.map((g) => (
                            <div key={g.key} className="py-1">
                                <p className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{g.title}</p>
                                {g.items.map((item, n) => {
                                    const i = g.start + n;
                                    const Icon = g.icon;
                                    return (
                                        <button
                                            key={`${g.key}-${item.id}`}
                                            id={`${listId}-${i}`}
                                            type="button"
                                            role="option"
                                            aria-selected={i === activeIndex}
                                            onMouseEnter={() => setActive(i)}
                                            onClick={() => go(item)}
                                            className={cn('flex w-full items-center gap-3 px-4 py-2 text-left', i === activeIndex ? 'bg-hover' : '')}
                                        >
                                            <Icon className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-sm text-white">{item.title}</span>
                                                {item.sub && <span className="block truncate text-xs text-gray-500">{item.sub}</span>}
                                            </span>
                                            {item.badge && <StatusBadge value={item.badge} />}
                                            {i === activeIndex && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-gray-500" aria-hidden="true" />}
                                        </button>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </>
    );
}
