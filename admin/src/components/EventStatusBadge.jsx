import { StatusBadge } from './ui/StatusBadge';

/**
 * What an event's status means to an admin, which is not always the stored word:
 *
 * - Both approvals are in but the event is still `pending`: the organiser has
 *   not paid for the venue yet (server eventService.goLiveIfReady). Not admin
 *   work, so it says "Venue not paid", not "Pending".
 * - Approval stores `approved`, and the lifecycle job only moves an event on
 *   when it runs, so a live event is labelled from its dates. This matches how
 *   the Upcoming / Ongoing / Completed tabs group it on the server.
 */
function eventDisplayStatus(event, now = Date.now()) {
    if (event.status === 'pending' && event.adminApproval?.status === 'approved'
        && (!event.venueApproval?.status || event.venueApproval.status === 'approved')) return 'venue_unpaid';
    if (!['approved', 'upcoming', 'ongoing'].includes(event.status)) return event.status;
    const start = new Date(event.startDateTime).getTime();
    const end = new Date(event.endDateTime).getTime();
    if (end <= now) return 'completed';
    if (start <= now) return 'ongoing';
    return 'upcoming';
}

export default function EventStatusBadge({ event }) {
    const shown = eventDisplayStatus(event);
    if (shown === 'venue_unpaid') {
        return <StatusBadge tone="warning" title="Approved. It goes live once the organiser pays for the venue.">Venue not paid</StatusBadge>;
    }
    return <StatusBadge value={shown} />;
}
