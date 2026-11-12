import { cn } from '../../lib/cn';

/**
 * Table primitives with the admin's standard spacing.
 *
 * The wrapper keeps the `overflow-x-auto` class on purpose: index.css gives any
 * table inside it a readable minimum width and single-line cells, so on a phone
 * the table scrolls sideways instead of crushing its columns.
 */
export function Table({ className = '', children, label }) {
    return (
        <div className="overflow-x-auto">
            <table className={cn('w-full text-left text-sm', className)} aria-label={label}>
                {children}
            </table>
        </div>
    );
}

export function THead({ children }) {
    return (
        <thead className="border-b border-line">
            <tr>{children}</tr>
        </thead>
    );
}

export function Th({ className = '', children, ...props }) {
    return (
        <th scope="col" className={cn('px-5 py-3 text-xs font-medium uppercase tracking-wide text-gray-400', className)} {...props}>
            {children}
        </th>
    );
}

export function TBody({ children }) {
    return <tbody className="divide-y divide-line">{children}</tbody>;
}

export function Td({ className = '', children, ...props }) {
    return (
        <td className={cn('px-5 py-3.5 align-middle text-gray-300', className)} {...props}>
            {children}
        </td>
    );
}
