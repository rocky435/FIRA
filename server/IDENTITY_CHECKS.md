# Identity checks (government ID and PAN)

Admins check identity documents by hand in the admin app (**ID Checks** page, and
**Venue Owners**). Two separate checks:

| Check | Who | What it unlocks |
|---|---|---|
| Government ID | Venue owners | An admin can approve their venues only after it is verified |
| PAN | Event organisers | Their ticket earnings can be paid out only after it is verified |

Each check has a status:
- `none`: nothing submitted.
- `pending`: submitted, waiting for an admin.
- `verified`: checked and accepted.
- `rejected`: checked and refused. `rejectionReason` says why, and the user should upload again.

Submitting again from any status sets it back to `pending`. On every decision the
user gets a notification (`verification_approved` / `verification_rejected`) through
in-app, Web Push and FCM. Its `data.link` is `/dashboard/settings`.

Code: `services/identityService.js`. Tests: `__tests__/identityVerification.test.ts`.

## API for the apps

Base URL `https://api.letsfira.com/api`, with `Authorization: Bearer <login token>`.

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/users/me/identity` | none | `{ govId, pan }` (shape below) |
| PUT | `/users/me/identity/pan` | `{ panNumber, panDocument }` | `200 { govId, pan }`, or `400 { error, field }` |
| PUT | `/users/me/identity/gov-id` | `{ govIdType, govIdNumber, govIdDocument }` | `200 { govId, pan }`, or `400 { error, field }` |

```json
{
  "govId": { "status": "pending", "type": "aadhar", "numberLast4": "1234", "hasDocument": true, "rejectionReason": null, "reviewedAt": null },
  "pan":   { "status": "rejected", "numberLast4": "234F", "hasDocument": true, "rejectionReason": "Photo is blurry", "reviewedAt": "2026-10-29T10:00:00.000Z" }
}
```

Rules:
- **Upload the photo first.** Send `POST /upload/single` as multipart, with field `image` and `folder=gov-ids`. Pass the returned `url` as `panDocument` or `govIdDocument`. The server only accepts URLs from that private folder.
- `panNumber` must look like `ABCDE1234F`. The server upper-cases it.
- `govIdType` is one of `aadhar`, `pan`, `driving_license`, `passport`, `voter_id`.
- On a `400`, `field` names the input to mark as wrong: `panNumber`, `panDocument`, `govIdType`, `govIdNumber` or `govIdDocument`.
- The full number is never sent back, only `numberLast4`.

## What the apps should show

1. **Settings → Identity Verification:** status of PAN (and of the government ID for venue owners), the rejection reason, and an Add / Upload again button.
2. **Creating an event, at the payout step:** if PAN status is `none` or `rejected`, ask for the PAN number and a PAN card photo before finishing. `pending` is enough to publish. The website does this; the server does not block event creation, so older app versions keep working.
3. **Becoming a venue owner:** the existing government ID fields. Once submitted, the ID is `pending`.

## Admin side

- **ID Checks** page: everyone with something pending, a photo link that works for 10 minutes, and Verify / Reject (rejecting needs a reason).
- **Venue Owners:** the same controls on each owner.
- **Venues → Approve** is refused until the owner's government ID is verified. Venues that are already approved stay approved.
- **Event settlement panel:** recording a payout is refused (`409`, `code: "pan_not_verified"`) until the organiser's PAN is verified. The panel shows a warning instead of the form.
- Every decision is in the **Audit Trail**: `approve` / `reject` on a user, with the field and reason.
