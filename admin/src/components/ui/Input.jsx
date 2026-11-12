import { forwardRef, useId } from 'react';

export const Input = forwardRef(({ label, error, id: idProp, helperText, leftIcon, rightIcon, className = '', ...props }, ref) => {
    // The label is tied to its field, so clicking it focuses the field and
    // screen readers announce it (it used to be a detached <label>).
    const autoId = useId();
    const id = idProp || autoId;
    return (
        <div className="w-full">
            {label && (
                <label htmlFor={id} className="block text-sm font-medium text-gray-300 mb-1.5">
                    {label}
                </label>
            )}
            <div className="relative">
                {leftIcon && (
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300">
                        {leftIcon}
                    </div>
                )}
                <input
                    id={id}
                    ref={ref}
                    className={`
          w-full h-10 px-3.5 rounded-xl text-sm
          bg-surface border border-line
          text-white placeholder-gray-500
          focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500/60
          transition-all duration-200
          ${leftIcon ? 'pl-10' : ''}
          ${rightIcon ? 'pr-10' : ''}
          ${error ? 'border-red-500/50 focus:ring-red-500/50 focus:border-red-500/50' : ''}
          ${className}
        `}
                    {...props}
                />
                {rightIcon && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 flex items-center justify-center">
                        {rightIcon}
                    </div>
                )}
            </div>
            {error && (
                <p className="mt-2 text-sm text-red-400">{error}</p>
            )}
            {helperText && !error && (
                <p className="mt-2 text-sm text-gray-300">{helperText}</p>
            )}
        </div>
    );
});

Input.displayName = 'Input';
