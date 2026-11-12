import { createContext, useContext } from 'react';

/**
 * Context + hook for the in-app confirm dialog (ConfirmDialog.jsx renders it).
 * Kept apart from the component file so React Fast Refresh keeps working.
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Block this user?', confirmLabel: 'Block', tone: 'danger' }))) return;
 */
export const ConfirmContext = createContext(null);

export function useConfirm() {
    const confirm = useContext(ConfirmContext);
    // Outside the provider fall back to the native dialog rather than throwing,
    // so a page never loses its safety check.
    return confirm || ((options) => Promise.resolve(window.confirm(
        typeof options === 'string' ? options : [options?.title, options?.message].filter(Boolean).join('\n\n')
    )));
}
