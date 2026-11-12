import { cn } from '../../lib/cn';

/**
 * Segmented control for a list's status filter ("All / Active / Blocked").
 *
 * `options` is either strings or { value, label, count }. Scrolls sideways on a
 * phone rather than wrapping onto a second line.
 */
export function FilterTabs({ options, value, onChange, label = 'Filter', className = '' }) {
    const items = options.map((o) => (typeof o === 'string' ? { value: o, label: o.charAt(0).toUpperCase() + o.slice(1) } : o));
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
                            className={cn(
                                'inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                                active ? 'bg-white text-black' : 'text-gray-400 hover:bg-hover hover:text-white'
                            )}
                        >
                            {item.label}
                            {item.count != null && item.count > 0 && (
                                <span className={cn('rounded-full px-1.5 text-xs tabular-nums', active ? 'bg-black/10' : 'bg-white/10 text-gray-300')}>
                                    {item.count}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
