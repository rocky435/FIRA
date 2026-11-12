import { createContext, useContext } from 'react';

/**
 * Context + hook for toasts (Toast.jsx renders them). Kept apart from the
 * component file so React Fast Refresh keeps working.
 *
 *   const toast = useToast();
 *   toast.success('User blocked');
 *   toast.error(err.message || 'Could not block user');
 */
export const ToastContext = createContext(null);

const fallback = {
    success: () => {},
    error: (m) => { if (m) window.alert(m); },
    info: () => {},
};

export function useToast() {
    return useContext(ToastContext) || fallback;
}
