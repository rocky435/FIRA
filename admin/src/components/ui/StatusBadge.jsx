import { cn } from '../../lib/cn';
import { TONES, toneFor, humanize } from '../../lib/statusStyles';

/**
 * A small coloured pill for a status, role or badge value.
 *
 *   <StatusBadge value="pending" />            -> amber "Pending"
 *   <StatusBadge value="venue_owner" />        -> blue "Venue Owner"
 *   <StatusBadge tone="success" icon={Check}>Verified</StatusBadge>
 *
 * The colour comes from lib/statusStyles.js unless `tone` is given.
 */
export function StatusBadge({ value, tone, icon: Icon, children, className = '', title }) {
    const resolved = tone || toneFor(value);
    return (
        <span
            title={title}
            className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium leading-5 whitespace-nowrap',
                TONES[resolved] || TONES.neutral,
                className
            )}
        >
            {Icon && <Icon className="w-3.5 h-3.5" aria-hidden="true" />}
            {children ?? humanize(value)}
        </span>
    );
}
