import { cn } from '../../lib/cn';

/**
 * The admin's one surface: a solid card on the page background. Replaces the
 * `bg-white/[0.02] backdrop-blur-sm border-white/[0.08]` glass each page spelled
 * out by hand.
 *
 * `title` / `description` / `actions` render a header row; `padded={false}` is
 * for content (tables, lists) that brings its own spacing.
 */
export function Card({ title, description, actions, footer, padded = true, className = '', bodyClassName = '', children, ...props }) {
    const hasHeader = title || description || actions;
    return (
        <section className={cn('bg-surface border border-line rounded-2xl', className)} {...props}>
            {hasHeader && (
                <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 pb-4">
                    <div className="min-w-0">
                        {title && <h2 className="text-base font-semibold text-white">{title}</h2>}
                        {description && <p className="mt-0.5 text-sm text-gray-400">{description}</p>}
                    </div>
                    {actions && <div className="flex items-center gap-2">{actions}</div>}
                </header>
            )}
            <div className={cn(padded && (hasHeader ? 'px-5 pb-5' : 'p-5'), bodyClassName)}>{children}</div>
            {footer && <footer className="border-t border-line px-5 py-3">{footer}</footer>}
        </section>
    );
}
