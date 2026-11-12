/**
 * Entrance wrappers used across the admin pages.
 *
 * These used to be framer-motion components (a 120 kB chunk) that slid content
 * 40-60px in as it scrolled into view - busy for a tool people use all day. They
 * now render a plain div with a short CSS fade on mount. The props are unchanged
 * (delay, duration, direction, once are accepted and `delay` is honoured), so the
 * pages that import them keep working without edits. Reduced-motion users get
 * no animation at all (index.css).
 */

function Entrance({ children, className = '', delay = 0, kind }) {
    return (
        <div
            className={`${kind} ${className}`.trim()}
            style={delay ? { animationDelay: `${Math.min(delay, 0.3)}s` } : undefined}
        >
            {children}
        </div>
    );
}

// eslint-disable-next-line no-unused-vars
export function FadeIn({ children, delay = 0, duration, direction, className = '', once }) {
    return <Entrance kind="animate-fade-in" delay={delay} className={className}>{children}</Entrance>;
}

// eslint-disable-next-line no-unused-vars
export function SlideUp({ children, delay = 0, duration, className = '', once }) {
    return <Entrance kind="animate-slide-up" delay={delay} className={className}>{children}</Entrance>;
}
