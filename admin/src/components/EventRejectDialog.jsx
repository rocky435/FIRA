import { useId, useState } from 'react';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';

/**
 * Asks for the reason sent to the organizer when an event is rejected. Used by
 * the Events list and the event page. Give it a `key` per event so each opening
 * starts with an empty reason box.
 */
export default function EventRejectDialog({ event, busy, onCancel, onReject }) {
    const [reason, setReason] = useState('');
    const id = useId();
    return (
        <Modal
            open={Boolean(event)}
            onClose={onCancel}
            dismissible={!busy}
            title="Reject event?"
            description={event ? `Give a reason for rejecting "${event.name}". It is sent to the organizer.` : undefined}
            footer={(
                <>
                    <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
                    <Button variant="danger" onClick={() => onReject(reason.trim())} isLoading={busy}>Reject event</Button>
                </>
            )}
        >
            <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-gray-300">Reason</label>
            <textarea
                id={id}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. The event description is missing the venue address."
                rows={5}
                className="w-full resize-none rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:border-violet-500/60 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
            />
        </Modal>
    );
}
