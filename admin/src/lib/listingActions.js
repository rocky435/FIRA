import { useConfirm } from '../components/ui/confirmContext';
import { useToast } from '../components/ui/toastContext';
import adminApi from '../api/adminApi';

/**
 * The approve / reject / block / delete actions for venues, creators and events,
 * written once so the list pages and the detail pages say the same thing and call
 * the same endpoint. Each action is { title, message, confirmLabel, danger, call,
 * done }; useConfirmedAction() runs one.
 */

// The status route stores 'blocked'; the Venue model's own word is 'suspended'.
// Either one means hidden, and both get Unblock.
export const isVenueBlocked = (status) => status === 'blocked' || status === 'suspended';

export const VENUE_DELETE_MESSAGE = 'It will be removed from all listings. Upcoming bookings are cancelled and what guests paid is added to Refunds. A venue with upcoming events cannot be removed until those events are dealt with.';
export const EVENT_DELETE_MESSAGE = 'It will be removed from all listings. If tickets were sold, they are cancelled and their refunds are added to Refunds for you to pay.';
export const brandDeleteMessage = (owner) =>
    `This permanently removes the creator profile and its posts, and resets ${owner}'s verified badge so they can create a new profile. This cannot be undone.`;

export function venueActions(venue) {
    const name = `"${venue.name}"`;
    const setStatus = (status) => () => adminApi.updateVenueStatus(venue._id, status);
    return {
        approve: { title: `Approve ${name}?`, message: 'It will be publicly listed.', confirmLabel: 'Approve venue', call: setStatus('approved'), done: `${name} is approved` },
        reject: { title: `Reject ${name}?`, message: 'The listing will not be published.', confirmLabel: 'Reject venue', danger: true, call: setStatus('rejected'), done: `${name} is rejected` },
        block: { title: `Block ${name}?`, message: 'It will be hidden from all listings.', confirmLabel: 'Block venue', danger: true, call: setStatus('blocked'), done: `${name} is blocked` },
        unblock: { title: `Unblock ${name}?`, message: 'It will be publicly listed again.', confirmLabel: 'Unblock venue', call: setStatus('approved'), done: `${name} is unblocked` },
        // Soft delete on the server: the venue leaves every listing but its
        // bookings and payout history stay intact for reconciliation.
        remove: { title: `Delete ${name}?`, message: VENUE_DELETE_MESSAGE, confirmLabel: 'Delete venue', danger: true, call: () => adminApi.deleteVenue(venue._id), done: `${name} was deleted` },
    };
}

/** Which venue actions apply in its current state. */
export function venueAvailable(venue) {
    return {
        approve: venue.status === 'pending',
        reject: venue.status === 'pending',
        block: venue.status === 'approved',
        unblock: isVenueBlocked(venue.status),
        remove: true,
    };
}

export function brandActions(brand) {
    const name = `"${brand.name}"`;
    const owner = brand.owner?.name || brand.user?.name || 'its owner';
    const setStatus = (status) => () => adminApi.updateBrandStatus(brand._id, status);
    return {
        approve: { title: `Approve ${name}?`, message: 'They will be publicly visible and earn a verified badge.', confirmLabel: 'Approve creator', call: setStatus('approved'), done: `${name} is approved` },
        reject: { title: `Reject ${name}?`, message: 'Their creator application will be turned down.', confirmLabel: 'Reject creator', danger: true, call: setStatus('rejected'), done: `${name} is rejected` },
        block: { title: `Block ${name}?`, message: 'Their profile will be hidden and their verified badge removed.', confirmLabel: 'Block creator', danger: true, call: setStatus('blocked'), done: `${name} is blocked` },
        unblock: { title: `Unblock ${name}?`, message: 'Their profile will be visible again and the verified badge restored.', confirmLabel: 'Unblock creator', call: setStatus('approved'), done: `${name} is unblocked` },
        // Hard delete. Unlike block, this removes the profile entirely and resets
        // the owner's verified badge, letting them apply again from scratch.
        remove: { title: `Delete ${name}?`, message: brandDeleteMessage(owner), confirmLabel: 'Delete creator', danger: true, call: () => adminApi.deleteBrand(brand._id), done: `${name} was deleted` },
    };
}

export function brandAvailable(brand) {
    return {
        approve: brand.status === 'pending',
        reject: brand.status === 'pending',
        block: brand.status === 'approved',
        unblock: brand.status === 'blocked',
        // Offered whatever the status: its purpose is to free the owner to
        // re-apply, which is as valid for a rejected or blocked profile.
        remove: true,
    };
}

// The server takes the admin from the session; this used to also send a
// hardcoded adminId = 'admin-user-id', which the server ignores.
export const decideEvent = (eventId, decision, reason) => adminApi.adminApproveEvent(eventId, undefined, decision, reason);

export function eventActions(event) {
    const name = `"${event.name}"`;
    return {
        approve: { title: `Approve ${name}?`, message: 'It will go live immediately.', confirmLabel: 'Approve event', call: () => decideEvent(event._id, 'approved'), done: `${name} is approved` },
        block: { title: `Block ${name}?`, message: 'It will be hidden from all listings, and the organiser is told to contact FIRA. Only an admin can unblock it.', confirmLabel: 'Block event', danger: true, call: () => adminApi.updateEventStatus(event._id, 'blocked'), done: `${name} is blocked` },
        // Admin-only: the organiser cannot lift a block. The server puts the event
        // back to the status it had when it was blocked.
        unblock: { title: `Unblock ${name}?`, message: 'It goes back to the status it had before it was blocked, and the organiser is notified.', confirmLabel: 'Unblock event', call: () => adminApi.unblockEvent(event._id), done: `${name} is unblocked` },
        // Soft delete on the server: tickets and revenue stay queryable. If tickets
        // were sold, the server cancels them and raises their refunds - this is
        // also how an organizer's removal request is approved.
        remove: { title: `Delete ${name}?`, message: EVENT_DELETE_MESSAGE, confirmLabel: 'Delete event', danger: true, call: () => adminApi.deleteEvent(event._id), done: `${name} was deleted` },
    };
}

// Approve/Reject is offered while the event still needs the admin's decision.
export const eventAwaitsAdmin = (event) =>
    event.adminApproval?.status !== 'approved' && !['rejected', 'cancelled', 'blocked'].includes(event.status);

/**
 * Confirm, call, toast. Resolves true when the action went through.
 *
 *   const runAction = useConfirmedAction();
 *   if (await runAction(venueActions(v).approve)) reload();
 */
export function useConfirmedAction() {
    const confirm = useConfirm();
    const toast = useToast();
    return async ({ title, message, confirmLabel, danger, call, done }) => {
        const ok = await confirm({ title, message, confirmLabel, tone: danger ? 'danger' : undefined });
        if (!ok) return false;
        try {
            await call();
            toast.success(done);
            return true;
        } catch (err) {
            // Most often on a venue approve: the owner's government ID is not
            // verified yet, and the server's message says where to do that.
            toast.error(err?.message || 'Something went wrong');
            return false;
        }
    };
}
