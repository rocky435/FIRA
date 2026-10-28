// Capitalised so the linter sees <Motion.div> as a use (it ignores JSX member names).
import { motion as Motion } from 'framer-motion';

const directionOffset = {
    up: { y: 40 },
    down: { y: -40 },
    left: { x: 40 },
    right: { x: -40 },
    none: {},
};

export function FadeIn({
    children,
    delay = 0,
    duration = 0.5,
    direction = 'up',
    className = '',
    once = true,
}) {
    const variants = {
        hidden: {
            opacity: 0,
            ...directionOffset[direction],
        },
        visible: {
            opacity: 1,
            x: 0,
            y: 0,
            transition: {
                duration,
                delay,
                ease: [0.25, 0.1, 0.25, 1],
            },
        },
    };

    return (
        <Motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once, amount: 0.2 }}
            variants={variants}
            className={className}
        >
            {children}
        </Motion.div>
    );
}

export function SlideUp({
    children,
    delay = 0,
    duration = 0.6,
    className = '',
    once = true,
}) {
    const variants = {
        hidden: {
            opacity: 0,
            y: 60,
        },
        visible: {
            opacity: 1,
            y: 0,
            transition: {
                duration,
                delay,
                ease: [0.25, 0.1, 0.25, 1],
            },
        },
    };

    return (
        <Motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once, amount: 0.15 }}
            variants={variants}
            className={className}
        >
            {children}
        </Motion.div>
    );
}
