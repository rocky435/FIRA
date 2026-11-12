import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Join class names and let later Tailwind classes win over earlier ones, so a
 * component's defaults can be overridden with a plain `className` prop
 * (`cn('px-4', 'px-2')` -> 'px-2').
 */
export function cn(...inputs) {
    return twMerge(clsx(inputs));
}
