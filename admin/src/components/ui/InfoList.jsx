import { cn } from '../../lib/cn';

/**
 * Label / value pairs for a detail page ("Venue type: Rooftop").
 *
 *   <InfoList items={[{ label: 'City', value: 'Pune' }, { label: 'Rules', value: rules, wide: true }]} />
 *
 * Items whose value is null, undefined or '' are left out, so a page can list
 * every field it knows about without printing rows of "N/A". `wide` spans both
 * columns (long text).
 */
export function InfoList({ items, className = '' }) {
    const shown = items.filter((i) => i && i.value !== null && i.value !== undefined && i.value !== '');
    if (shown.length === 0) return null;
    return (
        <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2', className)}>
            {shown.map((item) => (
                <div key={item.label} className={cn('min-w-0', item.wide && 'sm:col-span-2')}>
                    <dt className="text-xs text-gray-400">{item.label}</dt>
                    <dd className="mt-1 break-words text-sm text-white">{item.value}</dd>
                </div>
            ))}
        </dl>
    );
}
