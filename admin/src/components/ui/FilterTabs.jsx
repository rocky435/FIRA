import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '../../lib/cn';

const normalise = (o) => (typeof o === 'string' ? { value: o, label: o.charAt(0).toUpperCase() + o.slice(1) } : o);

function CountPill({ count, active }) {
    if (count == null || count <= 0) return null;
    return (
        <span className={cn('rounded-full px-1.5 text-xs tabular-nums', active ? 'bg-white/20' : 'bg-white/10 text-gray-300')}>
            {count}
        </span>
    );
}

const tabClass = (active) => cn(
    'inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
    active ? 'bg-brand-grad text-white shadow-md shadow-violet-900/30' : 'text-gray-400 hover:bg-hover hover:text-white'
);

/**
 * The last tab: a menu of the less-used filters. When one of them is chosen the
 * tab takes its name ("Completed ▾") and shows as selected.
 *
 * The menu is position: fixed from the button's rect, because the tab strip
 * scrolls sideways on a phone and an absolutely placed menu would be clipped.
 */
function MoreTab({ items, value, onChange, label }) {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState(null);
    const buttonRef = useRef(null);
    const menuRef = useRef(null);
    const chosen = items.find((i) => i.value === value);

    useEffect(() => {
        if (!open) return undefined;
        const close = (e) => {
            if (e.type === 'keydown' && e.key !== 'Escape') return;
            if (e.type === 'mousedown' && (menuRef.current?.contains(e.target) || buttonRef.current?.contains(e.target))) return;
            setOpen(false);
            if (e.type === 'keydown') buttonRef.current?.focus();
        };
        const dismiss = () => setOpen(false);
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', close);
        window.addEventListener('resize', dismiss);
        window.addEventListener('scroll', dismiss, true);
        (menuRef.current?.querySelector('[aria-checked="true"]') || menuRef.current?.querySelector('[role="menuitemradio"]'))?.focus();
        return () => {
            document.removeEventListener('mousedown', close);
            document.removeEventListener('keydown', close);
            window.removeEventListener('resize', dismiss);
            window.removeEventListener('scroll', dismiss, true);
        };
    }, [open]);

    const toggle = () => {
        if (!open) {
            const r = buttonRef.current.getBoundingClientRect();
            // Keep the 12rem menu on screen when the tab sits near the right edge.
            setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 200)) });
        }
        setOpen((o) => !o);
    };

    const onMenuKey = (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const nodes = [...menuRef.current.querySelectorAll('[role="menuitemradio"]')];
        const i = nodes.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown' ? Math.min(i + 1, nodes.length - 1) : Math.max(i - 1, 0);
        nodes[next]?.focus();
    };

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
                className={tabClass(Boolean(chosen))}
            >
                {chosen ? chosen.label : label}
                {chosen && <CountPill count={chosen.count} active />}
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden="true" />
            </button>
            {open && pos && (
                <div
                    ref={menuRef}
                    role="menu"
                    aria-label={label}
                    onKeyDown={onMenuKey}
                    style={{ top: pos.top, left: pos.left }}
                    className="fixed z-50 w-48 rounded-xl border border-line-strong bg-surface-raised py-1 shadow-2xl"
                >
                    {items.map((item) => {
                        const active = item.value === value;
                        return (
                            <button
                                key={item.value}
                                type="button"
                                role="menuitemradio"
                                aria-checked={active}
                                onClick={() => { onChange(item.value); setOpen(false); buttonRef.current?.focus(); }}
                                className={cn(
                                    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors focus:outline-none focus-visible:bg-hover',
                                    active ? 'text-white' : 'text-gray-300 hover:bg-hover hover:text-white'
                                )}
                            >
                                <span className="flex-1">{item.label}</span>
                                <CountPill count={item.count} active={false} />
                                {active && <Check className="h-4 w-4 text-violet-300" aria-hidden="true" />}
                            </button>
                        );
                    })}
                </div>
            )}
        </>
    );
}

/**
 * Segmented control for a list's status filter ("All / Active / Blocked").
 *
 * `options` is either strings or { value, label, count }. `more` takes the same
 * shape and folds the less-used filters into one last "Others ▾" tab, so the
 * strip stays short. Scrolls sideways on a phone rather than wrapping.
 */
export function FilterTabs({ options, more, moreLabel = 'Others', value, onChange, label = 'Filter', className = '' }) {
    const items = options.map(normalise);
    const moreItems = (more || []).map(normalise);
    return (
        <div className={cn('-mx-1 overflow-x-auto px-1', className)}>
            <div role="tablist" aria-label={label} className="inline-flex gap-1 rounded-xl border border-line bg-surface p-1">
                {items.map((item) => {
                    const active = item.value === value;
                    return (
                        <button
                            key={item.value}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => onChange(item.value)}
                            className={tabClass(active)}
                        >
                            {item.label}
                            <CountPill count={item.count} active={active} />
                        </button>
                    );
                })}
                {moreItems.length > 0 && <MoreTab items={moreItems} value={value} onChange={onChange} label={moreLabel} />}
            </div>
        </div>
    );
}
