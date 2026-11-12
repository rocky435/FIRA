// One headline figure card: the settlement panel's headline figures
// (Requirement 1.4).
//
// `value` is pre-formatted by the caller (via `formatInr`), so this stays a
// presentation component with no money knowledge. Same props as before; only
// the look moved to the solid surfaces the rest of the admin uses.
const ACCENTS = {
    violet: 'bg-violet-400',
    green: 'bg-green-400',
    blue: 'bg-blue-400',
    orange: 'bg-orange-400',
    pink: 'bg-pink-400',
    red: 'bg-red-400',
};

/**
 * @param {{ label: string, value: string, accent?: keyof typeof ACCENTS }} props
 */
export function FigureCard({ label, value, accent = 'violet' }) {
    return (
        <div className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
            <div className="flex items-center gap-2 text-sm text-gray-400">
                <span className={`h-2 w-2 shrink-0 rounded-full ${ACCENTS[accent] || ACCENTS.violet}`} aria-hidden="true" />
                {label}
            </div>
            <div className="mt-2 truncate text-xl font-semibold tabular-nums text-white sm:text-2xl">{value}</div>
        </div>
    );
}
