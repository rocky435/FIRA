import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
    LayoutDashboard, Building2, CalendarDays, Ticket, Star, IdCard, Wallet, Undo2, Tag, Megaphone, HandCoins,
    Users, UsersRound, ClipboardList, LogOut, PanelLeftClose, PanelLeftOpen, Menu, X, ChevronDown, Search,
} from 'lucide-react';
import logo from '../assets/logo.png';
import ErrorBoundary from './ErrorBoundary';
import adminApi from '../api/adminApi';
import { getAdminRoleFromToken, storeAdminRole, ROLE_EVENT } from '../lib/adminRole';
import InstallApp from './InstallApp';
import AlertsControl from './AlertsControl';
import { humanize } from '../lib/statusStyles';
import { cn } from '../lib/cn';

/**
 * The nav, grouped by what the admin is there to do. `pendingKey` names the
 * /admin/stats field whose count is shown as a badge, so the sidebar itself
 * says where work is waiting.
 */
const navGroups = [
    {
        label: 'Overview',
        color: 'var(--section-overview)',
        items: [{ href: '/', icon: LayoutDashboard, label: 'Dashboard' }],
    },
    {
        label: 'Review',
        color: 'var(--section-review)',
        items: [
            { href: '/venues', icon: Building2, label: 'Venues', pendingKey: 'pendingVenues' },
            { href: '/events', icon: Ticket, label: 'Events', pendingKey: 'pendingEvents' },
            { href: '/brands', icon: Star, label: 'Brands', pendingKey: 'pendingBrands' },
            { href: '/id-checks', icon: IdCard, label: 'ID Checks', pendingKey: 'pendingIdChecks' },
        ],
    },
    {
        label: 'Money',
        color: 'var(--section-money)',
        items: [
            { href: '/bookings', icon: CalendarDays, label: 'Venue Bookings' },
            { href: '/payouts/organisers', icon: HandCoins, label: 'Organiser payouts' },
            { href: '/payouts/venue-owners', icon: Wallet, label: 'Venue owner payouts' },
            { href: '/refunds', icon: Undo2, label: 'Refunds to be done', pendingKey: 'pendingRefunds' },
            { href: '/discount-codes', icon: Tag, label: 'Discount Codes' },
        ],
    },
    {
        label: 'People',
        color: 'var(--section-people)',
        items: [
            { href: '/users', icon: Users, label: 'Users' },
            { href: '/organisers', icon: Megaphone, label: 'Event Organisers' },
            { href: '/venue-owners', icon: UsersRound, label: 'Venue Owners' },
        ],
    },
    {
        label: 'System',
        color: 'var(--section-system)',
        items: [{ href: '/audit-trail', icon: ClipboardList, label: 'Audit Trail' }],
    },
];

/**
 * Role-based nav visibility (Requirements 3.3, 3.4) - unchanged from before the
 * redesign:
 * - super_admin (or a legacy admin with no adminRole): sees everything
 * - admin: sees everything; admin role assignment is guarded server-side
 * - moderator: no Users (block/unblock), Audit Trail, Refunds (approving sends
 *   money), ID Checks or Payouts - the server limits all of those to admin and
 *   super_admin.
 */
const MODERATOR_HIDDEN = new Set(['/users', '/audit-trail', '/refunds', '/id-checks', '/payouts/organisers', '/payouts/venue-owners', '/organisers']);

function getVisibleNavGroups(adminRole) {
    if (adminRole !== 'moderator') return navGroups;
    return navGroups
        .map((group) => ({ ...group, items: group.items.filter((item) => !MODERATOR_HIDDEN.has(item.href)) }))
        .filter((group) => group.items.length > 0);
}

/** `/venues/123` belongs to Venues; `/venue-owners` does not. */
function isActivePath(pathname, href) {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(`${href}/`);
}

function findCurrent(pathname, groups) {
    for (const group of groups) {
        const item = group.items.find((i) => isActivePath(pathname, i.href));
        if (item) return { group: group.label, color: group.color, item };
    }
    // Pages reached from inside a list (/payouts with every kind).
    if (pathname.startsWith('/payouts')) return { group: 'Money', color: 'var(--section-money)', item: { label: 'Payouts' } };
    return null;
}

const COLLAPSED_KEY = 'admin_sidebar_collapsed';
const STATS_REFRESH_MS = 2 * 60 * 1000;

function useIsDesktop() {
    const query = '(min-width: 1024px)';
    const [isDesktop, setIsDesktop] = useState(() => window.matchMedia(query).matches);
    useEffect(() => {
        const mq = window.matchMedia(query);
        const onChange = (e) => setIsDesktop(e.matches);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, []);
    return isDesktop;
}

function readStoredUser() {
    try {
        const data = JSON.parse(localStorage.getItem('fira_admin_auth') || 'null');
        return data ? { name: data.name || 'Admin', email: data.email || '' } : { name: 'Admin', email: '' };
    } catch {
        return { name: 'Admin', email: '' };
    }
}

function CountBadge({ count, collapsed }) {
    if (!count) return null;
    const text = count > 99 ? '99+' : String(count);
    if (collapsed) {
        return <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-surface" aria-hidden="true" />;
    }
    return (
        <span className="ml-auto rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums leading-none text-amber-300">
            {text}
        </span>
    );
}

function UserMenu({ user, roleLabel, onLogout }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const initial = (user.name || 'A').charAt(0).toUpperCase();

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={open}
                className="flex items-center gap-2 rounded-xl px-1.5 py-1 text-left hover:bg-hover"
            >
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-600 text-sm font-semibold text-white">
                    {initial}
                </span>
                <span className="hidden min-w-0 sm:block">
                    <span className="block max-w-[10rem] truncate text-sm font-medium text-white">{user.name}</span>
                    <span className="block text-xs text-gray-400">{roleLabel}</span>
                </span>
                <ChevronDown className={cn('hidden h-4 w-4 text-gray-500 transition-transform sm:block', open && 'rotate-180')} aria-hidden="true" />
            </button>
            {open && (
                <div role="menu" className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-line-strong bg-surface-raised p-1.5 shadow-2xl animate-fade-in">
                    <div className="px-3 py-2.5">
                        <p className="truncate text-sm font-medium text-white">{user.name}</p>
                        {user.email && <p className="truncate text-xs text-gray-400">{user.email}</p>}
                        <span className="mt-2 inline-block rounded-full border border-violet-500/25 bg-violet-500/10 px-2 py-0.5 text-xs text-violet-300">
                            {roleLabel}
                        </span>
                    </div>
                    <div className="my-1 h-px bg-line" />
                    <button
                        type="button"
                        role="menuitem"
                        onClick={onLogout}
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-300 hover:bg-red-500/10"
                    >
                        <LogOut className="h-4 w-4" aria-hidden="true" />
                        Sign out
                    </button>
                </div>
            )}
        </div>
    );
}

// `onLogout` is passed by App.jsx.
export default function AdminDashboardLayout({ children, onLogout }) {
    const location = useLocation();
    const isDesktop = useIsDesktop();
    const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true');
    const [drawerRequested, setDrawerOpen] = useState(false);
    // The drawer belongs to one page on a phone-sized screen: navigating or
    // widening to desktop closes it (adjusted during render, not in an effect).
    const [drawerPath, setDrawerPath] = useState(location.pathname);
    if (drawerPath !== location.pathname) {
        setDrawerPath(location.pathname);
        if (drawerRequested) setDrawerOpen(false);
    }
    const drawerOpen = drawerRequested && !isDesktop;
    const [stats, setStats] = useState(null);
    const [user] = useState(readStoredUser);

    const [adminRole, setAdminRole] = useState(getAdminRoleFromToken);
    // The level comes from the server (the token does not carry it): refreshed
    // when the app opens, and the menu follows if it changed.
    useEffect(() => {
        const onRole = (e) => setAdminRole(e.detail);
        window.addEventListener(ROLE_EVENT, onRole);
        adminApi.getMe().then((me) => storeAdminRole(me?.adminRole ?? null)).catch(() => {});
        return () => window.removeEventListener(ROLE_EVENT, onRole);
    }, []);
    const [navQuery, setNavQuery] = useState('');
    const visibleGroups = useMemo(() => getVisibleNavGroups(adminRole), [adminRole]);
    // The sidebar search narrows the menu to matching pages.
    const shownGroups = useMemo(() => {
        const q = navQuery.trim().toLowerCase();
        if (!q) return visibleGroups;
        return visibleGroups
            .map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q)) }))
            .filter((g) => g.items.length > 0);
    }, [visibleGroups, navQuery]);
    const roleLabel = adminRole ? humanize(adminRole) : 'Admin';

    useEffect(() => {
        localStorage.setItem(COLLAPSED_KEY, String(collapsed));
    }, [collapsed]);

    // Escape closes the mobile drawer; the page behind it does not scroll.
    useEffect(() => {
        if (!drawerOpen) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') setDrawerOpen(false); };
        const { overflow } = document.body.style;
        document.body.style.overflow = 'hidden';
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = overflow;
        };
    }, [drawerOpen]);

    // Pending counts for the nav badges. Refreshed on navigation (at most every
    // couple of minutes) so a badge clears soon after the work is done. A failure
    // just leaves the badges off - the nav never depends on it.
    const lastFetch = useRef(0);
    const loadStats = useCallback(() => {
        if (Date.now() - lastFetch.current < STATS_REFRESH_MS) return;
        lastFetch.current = Date.now();
        adminApi.getStats().then(setStats).catch(() => {});
    }, []);
    useEffect(() => { loadStats(); }, [location.pathname, loadStats]);
    useEffect(() => {
        const id = setInterval(() => { lastFetch.current = 0; loadStats(); }, STATS_REFRESH_MS);
        return () => clearInterval(id);
    }, [loadStats]);

    const handleLogout = () => {
        if (onLogout) {
            onLogout();
        } else {
            localStorage.removeItem('fira_admin_auth');
            localStorage.removeItem('fira_admin_token');
            window.location.reload();
        }
    };

    // Which nav item the current URL belongs to, for the top bar's "Group / Page".
    // A dozen string compares: cheaper to redo than to memoise.
    const current = findCurrent(location.pathname, visibleGroups);

    // On desktop the rail can be collapsed; the mobile drawer is always full width.
    const rail = isDesktop && collapsed;

    const nav = (
        <nav aria-label="Admin navigation" className="flex-1 overflow-y-auto px-3 py-4">
            {!rail && (
                <div className="relative mb-4">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" aria-hidden="true" />
                    <input
                        type="search"
                        value={navQuery}
                        onChange={(e) => setNavQuery(e.target.value)}
                        placeholder="Search"
                        aria-label="Search the menu"
                        className="h-9 w-full rounded-xl border border-line bg-surface-raised pl-9 pr-3 text-sm text-white placeholder-gray-500 focus:border-violet-500/60 focus:outline-none focus:ring-2 focus:ring-violet-500/25"
                    />
                </div>
            )}
            {shownGroups.length === 0 && <p className="px-3 text-sm text-gray-500">No page matches "{navQuery}".</p>}
            {shownGroups.map((group) => (
                <div key={group.label} className="mb-5 last:mb-0">
                    {rail ? (
                        <div className="mx-auto mb-2 h-px w-6 bg-line" aria-hidden="true" />
                    ) : (
                        <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{group.label}</p>
                    )}
                    <ul className="space-y-0.5">
                        {group.items.map((item) => {
                            const active = isActivePath(location.pathname, item.href);
                            const count = item.pendingKey ? stats?.[item.pendingKey] : 0;
                            const Icon = item.icon;
                            return (
                                <li key={item.href}>
                                    <Link
                                        to={item.href}
                                        aria-current={active ? 'page' : undefined}
                                        title={rail ? `${item.label}${count ? ` (${count} pending)` : ''}` : undefined}
                                        className={cn(
                                            'relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-150',
                                            rail && 'justify-center px-0',
                                            active
                                                ? 'bg-brand-grad text-white shadow-lg shadow-violet-900/40'
                                                : 'text-gray-400 hover:bg-hover hover:text-white'
                                        )}
                                    >
                                        {/* Inactive icons wear their area's colour; the active one is white on the gradient. */}
                                        <Icon className="h-[18px] w-[18px] shrink-0" style={active ? undefined : { color: group.color }} aria-hidden="true" />
                                        {!rail && <span className="truncate">{item.label}</span>}
                                        {rail && <span className="sr-only">{item.label}</span>}
                                        <CountBadge count={count} collapsed={rail} />
                                        {count > 0 && <span className="sr-only">, {count} pending</span>}
                                    </Link>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            ))}
        </nav>
    );

    const brand = (
        <Link to="/" className="flex min-w-0 items-center gap-2.5" aria-label="FIRA Admin home">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black">
                <img src={logo} alt="" className="h-full w-full object-contain" />
            </span>
            {!rail && (
                <span className="text-sm font-semibold text-white">
                    FIRA <span className="font-normal text-gray-400">Admin</span>
                </span>
            )}
        </Link>
    );

    return (
        <div className="min-h-screen bg-background">
            {/* Desktop sidebar */}
            <aside
                className={cn(
                    'fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-line bg-surface transition-[width] duration-200 lg:flex',
                    rail ? 'w-[72px]' : 'w-64'
                )}
            >
                <div className={cn('flex h-16 items-center border-b border-line px-4', rail ? 'justify-center' : 'justify-between')}>
                    {brand}
                </div>
                {nav}
                <div className="border-t border-line p-3">
                    <button
                        type="button"
                        onClick={() => setCollapsed((v) => !v)}
                        className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-gray-400 hover:bg-hover hover:text-white', rail && 'justify-center px-0')}
                        aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'}
                        title={rail ? 'Expand sidebar' : undefined}
                    >
                        {rail ? <PanelLeftOpen className="h-[18px] w-[18px]" aria-hidden="true" /> : <PanelLeftClose className="h-[18px] w-[18px]" aria-hidden="true" />}
                        {!rail && <span>Collapse</span>}
                    </button>
                </div>
            </aside>

            {/* Mobile drawer */}
            {drawerOpen && (
                <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
                    <div className="absolute inset-0 bg-black/70 animate-fade-in" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
                    <aside className="absolute inset-y-0 left-0 flex w-[17rem] max-w-[85vw] flex-col border-r border-line bg-surface shadow-2xl animate-slide-up">
                        <div className="flex h-16 items-center justify-between border-b border-line px-4">
                            {brand}
                            <button
                                type="button"
                                onClick={() => setDrawerOpen(false)}
                                className="rounded-lg p-2 text-gray-400 hover:bg-hover hover:text-white"
                                aria-label="Close navigation"
                            >
                                <X className="h-5 w-5" aria-hidden="true" />
                            </button>
                        </div>
                        {nav}
                        <div className="border-t border-line p-3">
                            <button
                                type="button"
                                onClick={handleLogout}
                                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-red-300 hover:bg-red-500/10"
                            >
                                <LogOut className="h-[18px] w-[18px]" aria-hidden="true" />
                                Sign out
                            </button>
                        </div>
                    </aside>
                </div>
            )}

            <div className={cn('flex min-h-screen min-w-0 flex-col transition-[padding] duration-200', rail ? 'lg:pl-[72px]' : 'lg:pl-64')}>
                {/* Top bar */}
                <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-background/90 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/75 sm:px-6 lg:px-8">
                    <button
                        type="button"
                        onClick={() => setDrawerOpen(true)}
                        className="-ml-1 rounded-lg p-2 text-gray-300 hover:bg-hover hover:text-white lg:hidden"
                        aria-label="Open navigation"
                        aria-expanded={drawerOpen}
                    >
                        <Menu className="h-5 w-5" aria-hidden="true" />
                    </button>
                    <div className="min-w-0 flex-1">
                        {current && (
                            <p className="flex min-w-0 items-center gap-2 truncate text-sm">
                                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: current.color }} aria-hidden="true" />
                                <span className="text-gray-500">{current.group}</span>
                                <span className="text-gray-600" aria-hidden="true">/</span>
                                <span className="truncate font-medium text-white">{current.item.label}</span>
                            </p>
                        )}
                    </div>
                    <InstallApp />
                    <AlertsControl />
                    <UserMenu user={user} roleLabel={roleLabel} onLogout={handleLogout} />
                </header>

                {/* min-w-0 matters on phones: a flex child's min-width defaults to
                    its content, so a wide table would stretch <main> past the
                    screen instead of scrolling inside its own wrapper. */}
                <main className="relative min-w-0 flex-1 pb-16" style={current?.color ? { '--section': current.color } : undefined}>
                    <div className="admin-content mx-auto w-full">
                        <ErrorBoundary fallbackMessage="Something went wrong in the admin panel.">
                            {children}
                        </ErrorBoundary>
                    </div>
                </main>
            </div>
        </div>
    );
}
