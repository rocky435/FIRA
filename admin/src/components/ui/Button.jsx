import { LoaderCircle } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * The admin button. Props are unchanged from the old version (variant, size,
 * isLoading, leftIcon, rightIcon), so every existing call site keeps working.
 * `className` now overrides defaults cleanly via cn().
 */
export function Button({
    variant = 'primary',
    size = 'md',
    isLoading = false,
    leftIcon,
    rightIcon,
    children,
    className = '',
    disabled,
    // No default `type`: some call sites (Login, the settlement form) rely on the
    // browser default of "submit" inside a <form>. Changing it would silently
    // stop those forms submitting.
    type,
    ...props
}) {
    const baseStyles = 'inline-flex items-center justify-center font-medium whitespace-nowrap rounded-xl transition-[color,background-color,filter,transform] duration-150 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';

    const variants = {
        // The website's main button: violet into pink.
        primary: 'bg-brand-grad text-white shadow-lg shadow-violet-900/30 hover:brightness-110 focus-visible:outline-violet-300',
        secondary: 'bg-surface-raised text-white border border-line-strong hover:bg-white/[0.08] focus-visible:outline-violet-400',
        ghost: 'bg-transparent text-gray-300 hover:bg-hover hover:text-white focus-visible:outline-violet-400',
        danger: 'bg-red-500 text-white hover:bg-red-600 focus-visible:outline-red-400',
        success: 'bg-green-600 text-white hover:bg-green-700 focus-visible:outline-green-400',
        violet: 'bg-brand-grad text-white shadow-lg shadow-violet-900/30 hover:brightness-110 focus-visible:outline-violet-300',
    };

    const sizes = {
        sm: 'h-8 px-3 text-sm gap-1.5',
        md: 'h-10 px-4 text-sm gap-2',
        lg: 'h-11 px-5 text-base gap-2',
    };

    return (
        <button
            type={type}
            className={cn(baseStyles, variants[variant] || variants.primary, sizes[size] || sizes.md, className)}
            disabled={disabled || isLoading}
            aria-busy={isLoading || undefined}
            {...props}
        >
            {isLoading ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : leftIcon}
            {children}
            {!isLoading && rightIcon}
        </button>
    );
}
