# ADR-0070: Speaking uploads use a verified, expiring intent

- Status: Accepted
- Date: 2026-10-03
- Related issues: [#207](https://github.com/AiHub-Ecosystem/aihub-be/issues/207), [#209](https://github.com/AiHub-Ecosystem/aihub-be/issues/209)
- Related: [ADR-0065](0065-aihub-owns-audio-asset-catalog-and-playback-urls.md), [ADR-0068](0068-avatar-is-a-user-account-owned-asset.md)

## Context

An Audio asset is created only after a client uploads directly to SeaweedFS and AIHUB verifies what arrived. The authenticated Organization and the resolved End-User ID must remain bound across the upload and completion requests, but the required organization-scoped object key does not contain the End-User ID. An incomplete upload also needs enough durable state to be cleaned up without becoming playable.

## Decision

1. AIHUB creates an Audio Upload Intent in Postgres. It binds the authenticated Organization, the exact End-User ID resolved from `X-User-Identity`, a server-generated asset ID and key, the expected content type and byte size, and a one-hour expiry. It is not an Audio asset and cannot be replayed.
2. The key is `orgs/{organizationId}/speaking/{assetId}/original`. AIHUB issues a five-minute presigned `PUT` for that one key, with the expected content type and length bound into the signature. While the intent is open, the same Organization and End-User ID may request a fresh five-minute URL for the same key and metadata. Refreshing does not extend the one-hour intent expiry. The client sends audio bytes directly to storage.
3. Completion is accepted only for the same Organization and End-User ID while the intent is open. AIHUB checks the stored object, not just the client's declaration. Accepted content types are `audio/wav`, `audio/mpeg`, `audio/mp4`, `audio/webm`, and `audio/ogg`; the object must be at least 100 bytes and at most 25 MiB.
4. A successful completion atomically creates the durable Audio asset and consumes the intent. The asset records the Organization, End-User ID, object key, content type, byte size, and a deadline 30 days after acceptance. Repeating a successful completion is idempotent. A missing object leaves the intent retryable until expiry. A type or size mismatch refuses the asset and permanently rejects the intent; AIHUB attempts to delete the object and retains cleanup state if deletion fails.
5. An expired intent cannot be completed. A cleanup job waits 24 hours after expiry, deletes any object at the intent's exact key, and then removes the intent. Failed deletes remain retryable; deleting a missing object succeeds. Rejected intents are never made completable again and remain until their uploaded object is removed.
6. Customer recordings use dedicated private buckets: Production uses `aihub-speaking-recordings` and Sandbox uses `aihub-sandbox-speaking-recordings`. They are separate from the public `ielts-task1` and `aihub-audio` buckets, the private `aihub-speaking-samples` bucket, and both Avatar buckets. Production and Sandbox use required `SEAWEEDFS_AUDIO_ASSET_BUCKET` and `SEAWEEDFS_SANDBOX_AUDIO_ASSET_BUCKET` settings, respectively, with no default or fallback. The buckets have no anonymous read, list, write, or delete policy. Storage operations fail closed until the selected deployment has its exact bucket setting and SeaweedFS credentials.
7. The 25 MiB maximum is an Audio object policy aligned with the provider's grading input contract. Upload bytes still bypass AIHUB and are not subject to the synchronous grading route's request-body ceiling.
8. Audio rows retain `organization_id` but do not have a local foreign key to `organizations`. Sandbox Organization identity is authoritative in the control plane and is intentionally not copied into the Sandbox database; the authenticated request supplies the validated Organization ID when creating and completing an intent. This follows the cross-database reference boundary established for Sandbox idempotency in migration `0023`.

## Consequences

- The durable intent prevents completion from attributing a recording to a different End-User ID and gives cleanup a durable, exact key to act on.
- Refreshing an upload URL restores upload capability after its five-minute expiry without changing the intent's identity, object key, expected metadata, or one-hour deadline.
- The intent adds temporary database state. Audio assets themselves remain durable Postgres reference data and never enter Redis.
- Audio Organization references are validated at the API identity boundary, not by a local foreign key, because the Sandbox database does not own Organization rows. Both environments still persist Organization ID and require it, together with the exact End-User ID and environment, to match on every intent and asset lookup.
- The retention/deletion slice consumes the 30-day deadline selected here; it does not choose a separate duration.
- SeaweedFS may not enforce the signed length. Completion's check of the stored object's actual size and content type is the guarantee.

## Considered options

- **Create the Audio asset when issuing the upload URL.** Rejected because a URL that is never used would leave a record for an object that does not exist.
- **Complete without an upload intent.** Rejected because the End-User ID is supplied independently on each request and is not part of the required object key; completion could otherwise attribute the object to another user in the Organization.
- **Route audio bytes through AIHUB.** Rejected because the client can upload directly, avoiding binary transit through the gateway.

## Update (2026-11-07)

Speaking upload URLs target `orgs/{organizationId}/speaking/{assetId}/upload` in the same private bucket; the durable asset key remains `/original`. Completion checks staging metadata, copies staging to final, checks final metadata, records the asset, then deletes staging best effort. The repository holds the per-intent row lock across storage verification and asset recording, so a concurrent completion sees the recorded asset without copying again. Storage calls inside the lock share a 20-second abort deadline, and the transaction timeout is 30 seconds so it outlives that deadline. Because Postgres also enforces a 10-second server-side idle-in-transaction timeout during storage calls, completion sets a transaction-local 35-second idle timeout before verification; the invariant is 20-second deadline < 30-second transaction timeout <= 35-second idle timeout. A client-side abort does not guarantee the server stops an in-flight copy; the residual window is the 10-second deadline slack and requires a replayed staging PUT plus a concurrent completion. Expired or rejected intent cleanup removes both keys, including a final object left by a crash before the asset row is written. At deploy time, an open intent whose client uploaded to the former `/original` URL has no staging object and receives the existing `NOT_FOUND`; the client requests a fresh URL and uploads again. Refreshed URLs also target staging.

## Update (2026-11-08): Organization-wide upload ceilings (#374)

Points 1–5 bounded one intent, and the route's rate limit bounds one API key.
Neither bounds an Organization: many keys multiply the per-key ceiling, and no
ceiling counted stored bytes. Because a full SeaweedFS disk also takes down
`aihub-db` and every other project on the shared VPS, an Organization needs its
own ceilings. They are recorded and enforced in
`src/modules/speaking/application/speaking-audio-org-ceiling.policy.ts`.

1. An Organization may hold **8** open, unexpired intents. At the 25 MiB
   per-intent ceiling that bounds outstanding upload bytes to 200 MiB per
   Organization at once. One recording of a full IELTS answer needs one intent;
   the rest is headroom for a client that abandons an upload and starts again.
2. An Organization may create **60** intents in any rolling hour, counted from
   the intent lifetime: an older intent has expired and its object is being
   swept, so it can no longer be used.
3. An Organization may hold **5 GiB** of stored Audio bytes at once: the sum of
   completed assets plus the bytes open intents may still turn into one. This is
   far above a real Organization's monthly recordings and far below the shared
   disk, so it only ever refuses an abusive Organization.
4. The counts and the intent write happen in one transaction under a
   per-organization advisory lock (`{organizationId}:speaking-audio:intents`),
   so two concurrent requests cannot both observe headroom. The decision itself
   is a pure function the repository calls under that lock, so a test reaches
   it without a database (`.claude/rules/infrastructure.md`).
5. An open- or issuance-ceiling refusal answers `429 RATE_LIMITED`; a
   stored-bytes refusal answers `429 QUOTA_EXCEEDED`. Both are counted on
   `aihub_rejected_total` as `rate_limit` and `quota` respectively, and neither
   returns an upload URL or writes an intent.
6. The ceilings add no state and no cleanup: open intents already expire, and
   completed assets already carry the 30-day retention this ADR records.

### Considered options for the ceilings

- **Configuration rather than constants.** Rejected for now: these are policy,
  and policy lives beside the use case. Make them settings only when a real
  customer is refused, which would also need a per-Organization override story.
- **Count stored bytes from storage listings.** Rejected: the assets table
  already holds every accepted byte size, and a listing cannot distinguish an
  AIHUB asset from an object written by another tenant of the shared host.
- **A per-Organization rate limit in Redis.** Rejected on the same grounds as
  ADR-0007: Redis is a counter cache, while a storage ceiling has to hold after
  a flush or a failover.
- **Reject at completion rather than at intent creation.** Rejected: the
  storage is already written by then, which is the cost the ceiling exists to
  prevent.
