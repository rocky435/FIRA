import { cn } from '../../lib/cn';

const TONES = {
    neutral: 'text-gray-400 hover:bg-hover hover:text-white',
    danger: 'text-red-400 hover:bg-red-500/15 hover:text-red-300',
    success: 'text-green-400 hover:bg-green-500/15 hover:text-green-300',
    warning: 'text-amber-300 hover:bg-amber-500/15 hover:text-amber-200',
};

/**
 * A row action that is only an icon (approve, block, delete…). `label` is both
 * the tooltip and what a screen reader announces - the old hand-drawn icon
 * buttons mostly had a title and nothing else.
 */
export function IconButton({ label, tone = 'neutral', icon, onClick, disabled, className = '' }) {
    const Icon = icon;
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={label}
            aria-label={label}
            className={cn('rounded-lg p-2 transition-colors disabled:pointer-events-none disabled:opacity-40', TONES[tone] || TONES.neutral, className)}
        >
            <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
    );
}

/** Row / select-all checkbox, the same size and colour on every list. */
export function RowCheckbox({ checked, onChange, label }) {
    return (
        <input
            type="checkbox"
            checked={checked}
            onChange={onChange}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 cursor-pointer rounded accent-violet-500"
            aria-label={label}
        />
    );
}
