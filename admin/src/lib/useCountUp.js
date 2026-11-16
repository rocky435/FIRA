import { useEffect, useRef, useState } from 'react';

const reducedMotion = () =>
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * A number that counts up to `target` over `duration` ms when it first shows or
 * changes - the dashboard's headline figures. Jumps straight to the value for
 * anyone who asked their device for less motion, and when `target` is not a
 * finite number.
 *
 * @param {number} target
 * @param {number} [duration]
 * @returns {number}
 */
export function useCountUp(target, duration = 800) {
    const finite = Number.isFinite(target);
    const [shown, setShown] = useState(() => (finite && !reducedMotion() ? 0 : target));
    const from = useRef(0);

    useEffect(() => {
        if (!finite || reducedMotion()) {
            from.current = target;
            // Nothing to animate: show the value as it is.
            const id = requestAnimationFrame(() => setShown(target));
            return () => cancelAnimationFrame(id);
        }
        const start = performance.now();
        const begin = from.current;
        let frame;
        const tick = (now) => {
            const t = Math.min(1, (now - start) / duration);
            const eased = 1 - (1 - t) ** 3; // ease-out
            setShown(begin + (target - begin) * eased);
            if (t < 1) frame = requestAnimationFrame(tick);
            else from.current = target;
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [target, finite, duration]);

    return shown;
}
