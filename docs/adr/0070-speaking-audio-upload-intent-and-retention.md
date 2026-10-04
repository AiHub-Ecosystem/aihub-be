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
