# ADR-0068: An Avatar is a User Account-owned asset

- Status: Accepted
- Date: 2026-10-02
- Related issues: [#214](https://github.com/AiHub-Ecosystem/aihub-be/issues/214), [#215](https://github.com/AiHub-Ecosystem/aihub-be/issues/215)
- Related: [ADR-0065](0065-aihub-owns-audio-asset-catalog-and-playback-urls.md), [ADR-0066](0066-cross-module-imports-are-checked-not-yet-forbidden.md), [ADR-0060](0060-writing-task1-sample-image-is-published-not-signed.md)

## Context

An AIHUB User Account needs an Avatar: an image that identifies it in the
Customer Web ([CONTEXT.md](../../CONTEXT.md)). ADR-0065 settled that AIHUB owns
customer-uploaded assets and mints their URLs, but every rule in it is written
for an Organization-owned asset: the record binds an Organization, and the key
starts with `orgs/{organizationId}/`. An Avatar belongs to a person, who may be
a member of several Organizations or of none.

ADR-0065 is not implemented yet, so the Avatar is the first durable
customer-uploaded asset AIHUB builds.

## Decision

1. An Avatar is owned by the User Account, not by any Organization, and an
   account has at most one. The database enforces the limit.
2. Its object key is `users/{userId}/avatar/{assetId}/original`. `userId`
   always comes from the authenticated token, never from the request, so the
   owner is provable from the key alone and no account can address another's
   object. A table constraint holds that the key names the record's owner.
3. Avatars live in their own private bucket, named by
   `SEAWEEDFS_USER_ASSET_BUCKET`. It has no default and never falls back to
   the Speaking sample bucket or the public Writing chart bucket; while it is
   unset, the Avatar routes answer `AVATAR_STORAGE_UNAVAILABLE`.
4. AIHUB mints the upload URL as ADR-0065 describes: a presigned `PUT` with the
   content type and length bound into the signature, so the bytes never pass
   through AIHUB.
5. The record is written only when the client completes the upload, after
   AIHUB has checked the stored object's size and type. No upload intent is
   stored between the two calls; completion rebuilds the key from the
   authenticated account.
6. Replacing goes through the same upload. When the account already has a
   different Avatar, completion deletes the previous object first and then
   changes the record. Removing deletes the object first and then the record.
   A failed object delete therefore changes nothing and answers
   `AVATAR_STORAGE_UNAVAILABLE`, and retrying finishes the job, because
   deleting a missing object succeeds.
7. Every record change is conditional on the Avatar the request read. When
   another request changed it first, the change does not apply, the request
   deletes the object it uploaded, and it answers `AVATAR_CHANGED`. A
   concurrent completion of the same asset is a repeat, not a lost race.

Everything else in ADR-0065, including AIHUB minting every URL and the gateway
never proxying bytes, applies unchanged.

## Consequences

- Avatars stay with the person across Organizations, and leaving an
  Organization does not touch them.
- Deleting an account will have to delete its Avatar first: the record refers
  to the account with `ON DELETE RESTRICT`.
- The completion check is the guarantee. Whether SeaweedFS enforces a signed
  `Content-Length` is unverified, and the check holds either way.
- If the database fails between deleting the previous object and changing
  the record, the record briefly names an object that no longer exists, until
  the completion is retried. This is the price of having no pending-deletion
  state: no orphan object and no queue to drain.
- An object that is uploaded but never completed stays in the bucket with no
  record. This is accepted for the first slice and tracked in
  [#217](https://github.com/AiHub-Ecosystem/aihub-be/issues/217).
- The Avatar module builds its own S3 client beside the Speaking sample
  adapter. Sharing one is deferred until the Audio asset gives a third user.

## Considered options

- **Organization-scoped keys, as ADR-0065.** Rejected: an Avatar would have to
  be copied or re-uploaded per Organization, and a person with no Organization
  could not have one.
- **Record a pending row at presign time.** Rejected: an upload that never
  lands would leave a record, and that state would need its own cleanup.
- **Reuse the Speaking sample bucket.** Rejected: ADR-0065 keeps
  customer-uploaded data out of the sample bucket, and a missing setting must
  never put a customer image into it.
- **Change the record first, then delete the previous object.** Rejected: a
  failed delete would leave the previous object with nothing naming it, and
  saving it would need a durable pending-deletion table and a retry loop.
- **A generic asset module now.** Rejected for the same reason ADR-0065 gave:
  generalise when the Audio asset exists, with two real shapes to compare.
