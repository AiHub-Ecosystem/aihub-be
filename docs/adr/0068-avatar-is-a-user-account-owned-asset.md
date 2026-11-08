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
3. Avatars live in their own bucket, named by
   `SEAWEEDFS_USER_ASSET_BUCKET`. It has no default and never falls back to
   the Speaking sample bucket or the public Writing chart bucket; while it is
   unset, the Avatar routes answer `AVATAR_STORAGE_UNAVAILABLE`. The bucket
   allows anonymous read and denies listing: the Avatar is published, not
   signed ([ADR-0069](0069-avatar-is-published-not-signed.md)).
4. AIHUB mints a presigned `PUT` with the content type and cache policy bound
   into the signature, so the bytes never pass through AIHUB. `Content-Length`
   reports the declared size but is not signed because browser Fetch controls
   that header; completion checks the actual stored size.
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
- Browser Fetch controls `Content-Length`, so the upload URL does not sign it.
  Completion checks the actual stored object and deletes an oversized upload;
  an uncompleted oversized object can remain until the daily sweep removes it.
- If the database fails between deleting the previous object and changing
  the record, the record briefly names an object that no longer exists, until
  the completion is retried. This is the price of having no pending-deletion
  state: no orphan object and no queue to drain.
- An object that is uploaded but never completed has no record. The operator
  command `avatar:sweep` ([#217](https://github.com/AiHub-Ecosystem/aihub-be/issues/217))
  deletes such objects once they are more than 24 hours old by storage's own
  clock, and only keys in the exact Avatar layout. A completion adopts an
  object only within one hour of it being stored, or when storage does not
  report its age, so the 23 hours between the two windows keep a sweep from
  ever racing a completion. The sweep reads records from the database of its
  own deployment, so production and Sandbox must use separate Avatar
  buckets; otherwise each would delete the other's live Avatars.
- The Avatar module builds its own S3 client beside the Speaking sample
  adapter. Sharing one is deferred until the Audio asset gives a third user.

## Considered options

- **Organization-scoped keys, as ADR-0065.** Rejected: an Avatar would have to
  be copied or re-uploaded per Organization, and a person with no Organization
  could not have one.
- **Record a pending row at presign time.** Rejected: an upload that never
  lands would leave a record, and that state would need its own cleanup.
- **A storage lifecycle rule.** Rejected: a rule on the Avatar prefix cannot
  tell a recorded object from an orphan and would expire live Avatars, and a
  staging prefix would change the upload flow and need WISPACE to configure
  the shared host.
- **Reuse the Speaking sample bucket.** Rejected: ADR-0065 keeps
  customer-uploaded data out of the sample bucket, and a missing setting must
  never put a customer image into it.
- **Change the record first, then delete the previous object.** Rejected: a
  failed delete would leave the previous object with nothing naming it, and
  saving it would need a durable pending-deletion table and a retry loop.
- **A generic asset module now.** Rejected for the same reason ADR-0065 gave:
  generalise when the Audio asset exists, with two real shapes to compare.

## Update (2026-11-08): upload URL issuance is bounded per account (#374)

Point 5 said no upload intent is stored. Presigning still stores no intent, and
completion still rebuilds the key from the authenticated account. What it now
also stores is the one fact the ceilings need: a count of outstanding grants.

1. Every issued upload URL is recorded in `user_avatar_upload_grants`, keyed by
   the account, the asset ID, and the exact object key, with the URL's own
   expiry. A row is `open` until its completion consumes it and `consumed`
   afterwards.
2. An account may hold **3** open (unconsumed, unexpired) grants at once. One
   covers setting or replacing the Avatar; the other two are headroom for a
   client that abandons an upload and starts again. Because the Avatar bucket
   is public-read, every open grant is also a writable public object until
   completion, so this number is what actually bounds a single account's
   reachable storage.
3. An account may be issued **10** URLs in any rolling hour. Abandoning an
   upload costs one issuance, so this bounds churn rather than concurrency. A
   consumed grant keeps counting toward the window: completing an upload never
   restores issuance headroom.
4. Both counts are read and the grant is written under one per-account advisory
   lock (`avatar:grants:{userId}`, distinct from completion's
   `avatar:{userId}`), so two concurrent requests cannot both observe headroom.
5. A refused issuance answers `429 RATE_LIMITED` with the window as
   `retry_after_ms`, is counted on `aihub_rejected_total{reason="rate_limit"}`,
   and never returns the signed URL. The URL is signed first because the grant
   has to record the signature's own expiry, and signing is a local
   computation over a request that never leaves the process; a refused
   signature is simply discarded.
6. A grant that has outlived its URL holds no slot, so an abandoned upload
   frees its slot without any cleanup job. Grants need no sweep of their own.

The values live in `src/modules/avatar/application/avatar-upload.policy.ts`
beside the use case that applies them.

### Considered options for the ceilings

- **Store nothing and count from storage listings.** Rejected: listing the
  bucket per request is far more expensive than one indexed row, and a listing
  cannot tell a grant AIHUB issued from an object someone else wrote.
- **A per-account rate limit in Redis only.** Rejected on ADR-0007's terms:
  Redis is a counter cache, not durable state, and the open-URL ceiling needs
  to survive a Redis flush.
- **Reuse the inferential "no intent" rule and let completion enforce it.**
  Rejected: a URL that is never completed is exactly the abuse case, so the
  limit has to bind before the URL is handed out.
