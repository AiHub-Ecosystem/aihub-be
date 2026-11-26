# Avatar upload session core — design

Date: 2026-11-26
Issue: #2052
Status: approved by grilling Q1–Q14

## Goal

Migrate Avatar onto the shared upload-session core in `src/modules/uploads` without changing the caller-visible contract. Speaking and Writing stay green.

## Decisions

1. Owner comes from the feature policy: user-only, no fabricated `organizationId` or `environment`.
2. The existing grant row is Avatar's durable upload-session record. No second table.
3. The storage descriptor carries optional `lastModified` and `etag`; the Avatar policy owns ETag binding and the one-hour completion window.
4. Core passes `requestId`, stored `contentType` and `byteSize` to `markPublished`. Avatar writes `avatar.set`/`avatar.replaced` with ADR-0195 ordering.
5. `retentionExpiresAt` becomes optional on the published-session view. Avatar has no separate retention clock.
6. The core sweep accepts a candidate-source port. Avatar's adapter maps both final and staging object listings to candidates; pagination stays in the core.
7. Avatar does not expose `refresh`; no new route.
8. Repeated completion returns the stored avatar with `created: false`. All Avatar error codes stay in its policy/adapters.

## Components

- `avatar-upload-session.policy.ts`: owner, keys, 2 MiB/20 MP, 5-minute URL, 1-hour window, 3/10 ceilings, raster sanitize, capacity error, `AVATAR_STORAGE_UNAVAILABLE`.
- `avatar-upload-session.adapters.ts`: repository adapter over grant/record/replace/consume, storage adapter over staging/final buckets, candidate-source adapter over object listings.
- `AvatarUploadService`: thin create/complete facade; read/remove remain local.
- `AvatarOrphanSweep`: delegates normal pagination to core sweep; `runRecovery` stays a bounded operator drain with its existing cursors.
- `avatar.module.ts`: binds `UPLOAD_SESSION_SERVICE` and `UPLOAD_SESSION_SWEEP` through composition root.

## Data flow

`create` → policy owner → `grantUpload(3, 10, 1h)` → signed PUT.
`complete` → inspect descriptor → reject if older than one hour or age unknown → ETag-bound read → sanitize/re-encode → publish final → hold user lock from reservation through record/replace → audit + consume grant → best-effort staging cleanup.

Final response uses bytes/content type from the decoded final object, not the declared values.

## Error and race rules

- Expired or age-unknown object: `NOT_FOUND`, delete staging object.
- Rejected image: `INVALID_REQUEST` or `PAYLOAD_TOO_LARGE`, delete both copies.
- Another first upload/replacement wins: `AVATAR_CHANGED`, delete only this request's copy.
- Lost race on same asset: return stored avatar, `created: false`.
- Final/record committed, cleanup fails: still `201`; ADR-0195 ordering preserved.
- Ingress deadline expired before storage work: `AVATAR_STORAGE_UNAVAILABLE`, no storage call.

## Tests

- Add policy spec: user-only owner, identical staging/final key.
- Keep existing HTTP, service, storage-contract and DB assertions unchanged.
- Extend only with new seam specs; do not delete assertions to go green.
- Run `bun run check:changed`, then `bun run verify` once at handoff.

## Docs

- ADR-0197 amends ADR-0068 decision 5, decision 6 and Update item 6; cross-link ADR-0068 and ADR-0196.
- After implementation, report Avatar and Speaking line counts before/after in issue #2052.

## Out of scope

No Speaking or Writing behavior change; no new Avatar route; no new durable table; no zero-copy stream work.
