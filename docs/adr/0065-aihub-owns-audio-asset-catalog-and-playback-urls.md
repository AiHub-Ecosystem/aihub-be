# ADR-0065: AIHUB owns the Audio asset catalog and its playback URLs

- Status: Accepted
- Date: 2026-10-01
- Related issue: [#206](https://github.com/AiHub-Ecosystem/aihub-be/issues/206)
- Related: [ADR-0015](0015-ai-speaking-json-url-boundary.md), [ADR-0060](0060-writing-task1-sample-image-is-published-not-signed.md), [ADR-0062](0062-speaking-sample-answer-public-copy.md), [ADR-0021](0021-customer-web-speaking-sandbox-boundary.md)

## Context

Speaking Pass-through audio is currently discarded: the Customer Web BFF streams
it to AIHUB and AIHUB buffers it only for one synchronous grading call
([ADR-0021](0021-customer-web-speaking-sandbox-boundary.md)). Nothing lets a
User replay a submission later.

Replay needs a durable Audio asset ([CONTEXT.md](../../CONTEXT.md)) that
retains recorded audio beyond one request. SeaweedFS on the `s3.wispace.app`
origin already stores audio ([ADR-0060](0060-writing-task1-sample-image-is-published-not-signed.md)),
and an AI service fetching an `audio_url` is already an approved downstream
shape ([ADR-0015](0015-ai-speaking-json-url-boundary.md)). What is undecided is
which side owns the durable record and the playback URL.

## Decision

AIHUB owns the Audio asset record and every URL minted from it. An AI service
consumes a URL that is already in its request; it never issues, stores, or
re-issues one.

1. The Audio asset is a durable AIHUB record binding an Organization-owned
   object to its owning Organization, the User who recorded it, an object key,
   content metadata, and a retention deadline. It is organization-owned
   reference data, not cache state: Redis is not a permitted store for it.
2. AIHUB mints both directions. It issues presigned upload URLs so a client
   pushes bytes straight to SeaweedFS without transiting AIHUB, and presigned
   playback URLs for replay. Both are short-lived and minted on demand from the
   durable record, never persisted.
3. An AI service receives an audio URL inside a grading request, fetches it
   within the operation deadline, and persists neither the URL nor the bytes
   after returning its result. Serving a later replay is AIHUB's call.
4. The gateway validates URL shape and approved origin but does not download
   or proxy asset bytes, unchanged from [ADR-0015](0015-ai-speaking-json-url-boundary.md).
5. Object keys are organization-scoped so deletion and retention are provable
   from the key alone:
   `orgs/{organizationId}/speaking/{assetId}/{objectName}`.
6. Customer-uploaded assets live in a private AIHUB-owned bucket, separate from
   the public WISPACE-owned `ielts-task1` bucket
   ([ADR-0060](0060-writing-task1-sample-image-is-published-not-signed.md)) and
   from the private sample bucket `aihub-speaking-samples`
   ([ADR-0062](0062-speaking-sample-answer-public-copy.md)). Publishing any
   customer recording is a separate decision that this ADR does not make.

Ownership follows the authorization knowledge, not the storage cost. Only
AIHUB can answer "may this User replay this submission?", because the answer
depends on Organization identity and entitlement. An AI service holding asset
records would have to call back into AIHUB to authorize every read, inverting
the existing boundary in [ADR-0015](0015-ai-speaking-json-url-boundary.md).

## Consequences

- Replay becomes possible without widening the gateway into a media server, and
  without any new per-read authorization round trip.
- Presigned playback URLs replace today's catalog-only 15-minute sample
  signature (`SPEAKING_AUDIO_URL_TTL_SECONDS`) for user recordings. The sample
  catalog path is unaffected and keeps its current behavior.
- An AI service's dependence on a presigned URL is time-bound. The caller must
  mint a URL valid for the whole operation deadline, or the service re-requests
  a fresh one; this is an integration precondition, not a new gateway contract.
- Retention becomes AIHUB's obligation. Expiry requires deleting the object
  and the record together, and an undeleted object is a privacy liability.
- The organization-scoped key prefix is what makes per-tenant deletion
  verifiable; a key layout without it would leave deletion unauditable.

## Considered options

- **AI services own the asset and issue playback URLs.** Rejected: it requires
  the service to learn Organization and User entitlement to authorize a read,
  which means either a callback to AIHUB on every read or a duplicated copy of
  authorization state that can drift from AIHUB's.
- **Serve public unsigned URLs for customer recordings, as the Speaking sample
  answer does** ([ADR-0062](0062-speaking-sample-answer-public-copy.md)).
  Rejected: that sample is public fixture data by construction. Customer
  recordings are Organization-owned private data, and an unauthenticated URL
  cannot be revoked once shared.
- **Proxy asset bytes through AIHUB.** Rejected: it moves multi-megabyte binary
  transit through the gateway, which [ADR-0015](0015-ai-speaking-json-url-boundary.md)
  deliberately avoids, and it would duplicate retrieval the provider already
  performs.
- **A generic blob/file module.** Rejected: no second asset class has this
  shape yet. Generalize when the second one exists, not before.
- **Keep audio ephemeral and let the Customer Web store it.** Rejected: the
  Customer Web is an invite-only sandbox
  ([ADR-0021](0021-customer-web-speaking-sandbox-boundary.md)), not the system
  of record for Organization-owned data.
