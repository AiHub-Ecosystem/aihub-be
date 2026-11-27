# ADR-0196: One upload session core serves Avatar, Speaking, and Writing

- Status: Accepted. The Avatar migration is amended by [ADR-0197](0197-avatar-upload-sessions-join-the-shared-core.md). Speaking's transaction boundary is amended by [ADR-0198](0198-speaking-audio-publication-and-cleanup-coordinate-through-postgres.md).
- Date: 2026-11-26
- Related issue: [#676](https://github.com/AiHub-Ecosystem/aihub-be/issues/676), [#677](https://github.com/AiHub-Ecosystem/aihub-be/issues/677), [#2010](https://github.com/AiHub-Ecosystem/aihub-be/issues/2010)
- Related: [ADR-0068](0068-avatar-is-a-user-account-owned-asset.md), [ADR-0069](0069-avatar-is-published-not-signed.md), [ADR-0070](0070-speaking-audio-upload-intent-and-retention.md), [ADR-0073](0073-single-adapter-seams-keep-their-di-ceremony.md), [ADR-0100](0100-writing-task1-chart-image-uploads.md), [ADR-0106](0106-cross-module-imports-are-forbidden-outside-published-seams.md), [ADR-0139](0139-bun-is-the-package-manager-node-stays-the-runtime.md), [ADR-0156](0156-restricted-cross-module-edges.md), [ADR-0194](0194-avatar-uploads-are-re-encoded-and-audited.md), [ADR-0195](0195-avatar-replacement-and-removal-commit-before-cleanup.md)

## Context

Speaking audio, Avatar images, and Writing chart images all issue a short-lived
upload URL, stage bytes privately, verify the stored bytes at completion,
publish an immutable object, record retention durably, and sweep what never
completed or aged out. ADR-0100 says Writing "reuses the Speaking upload intent
lifecycle"; that reuse copied code. `docs/agents/duplication-register.md:103-104,123`
records the real duplication (`invalidStoredObject` three times, the keyset
sweep loop in Speaking and Writing, and the safe-object-key rule). The line
counts quoted in #676 (2,098 / 2,053 / 1,825 on 2026-10-15) are issue claims,
not a repo record.

Two premises in #676 need correcting here. ADR-0066 is `Superseded by
ADR-0106`; cross-module imports outside a published seam are now an **error**,
not a warning, with the narrowed edges in ADR-0156. And ADR-0139 makes Bun the
package manager, so the gates are `bun run arch-check` and
`bun run check:imports`, not `pnpm`. This ADR changes no earlier decision and
needs no rule change: the chosen seam is a published seam.

## Decision

1. **Canonical model.** The shared domain term is **upload session**: the
   private staging bytes, the published artifact they may become, and the owner
   and environment bound at creation. `GLOSSARY.md` keeps the narrower
   "Writing chart upload" as a specialization. Statuses are the ones already in
   code and glossary: `open`, `rejected`, `publishing`, `published`, `expired`.
   There is no `VERIFIED` or `COMMITTED` state; verification is a guard on
   `open → publishing`, and "staged" describes the object, not the session.

2. **Owning module and seam.** One Nest module owns the core:
   `src/modules/uploads/` with `uploads.module.ts`. The module name must match
   its directory so dependency-cruiser discovers its `exports:` seam. It owns
   the session record, state transitions, the rolling-window gate, paged
   candidate selection/claim, and the orchestration of stage/publish/delete
   through ports. Consumers import only its application-level
   `public/` facade; CLI sweep factories are exported there as the existing
   `public/speaking-audio-upload-sweep.ts` and `public/avatar-sweep.ts` are.
   Concrete S3 adapters, bucket maps, hostnames, and presigned transports stay
   in each feature. The core does not live in `src/common` (organization policy
   and repositories are banned there) or in Gateway (`no-avatar-gateway-import`).

3. **Per-feature policy.** The core defines an `UploadSessionPolicy` port; each
   feature implements it in its own application layer and injects it. Limits,
   retention, verifier, lock/lease strategy, and neutral error reasons travel
   through that port. The core never imports a feature module. Writing's "at
   most five new sessions and at most five publications in any rolling one-hour
   window" (ADR-0100) is Writing policy, not a shared constant. Verification
   stays per feature: Speaking checks audio metadata; Avatar and Writing decode
   and re-encode raster bytes. A browser-declared SHA-256 digest remains Writing
   policy under #2010; it is not a field of the shared session.

4. **Completion.** Completion is keyed by session ID, idempotent, and monotonic.
   Verification happens at completion before publish. Success atomically
   records the published artifact and consumes the session; repeating it
   returns the existing publication record and never republishes. Failure marks
   the session `rejected`, leaves no published artifact, and leaves the staged
   object for the sweep. Bytes do not enter Postgres or a queue payload, but
   this is not the Claim Check pattern: there is no asynchronous
   `COMMITTED` transition and no detached verification worker.

5. **Limits and retention.** Two independent rolling windows are read from
   policy: active sessions by creation time and publications by publish time.
   `rejected`, `expired`, and swept sessions are not counted. A breach is
   refused before a URL is issued. Sweeping an unfinished session and sweeping
   an artifact past its retention deadline are separate classes; an artifact is
   never removed before its retention deadline, and retention is never handled
   by the unfinished-session sweep.

6. **Sweep.** Candidate selection is paged keyset `(createdAt, id)` with a
   claimed page (`FOR UPDATE SKIP LOCKED` or an equivalent lease) before the
   object delete, so two workers cannot double-delete or race a verification in
   flight. Delete the staged object first, then mark the record; a missing
   object counts as deleted. Avatar's object-store listing sweep stays owned by
   Avatar until its migration replaces it.

7. **Transaction boundary.** The core does not impose one boundary. It exposes
   a serialization/lease port and lets each feature keep its strategy:
   Speaking's row lock held across storage verification, Avatar's image work
   before its user lock, and Writing's 30-second `publishing` lease with its
   revocation fence. No downstream or storage call is made inside a transaction
   the core opens solely to change session state.

8. **DI answer to ADR-0073.** Keep the ceremony. One core port with one
   production adapter still gets a Symbol token, one composition-root binding,
   and a Nest export where it crosses modules. The 2026-10-15 artifact cited by
   #676 is a line-count scan, not a DI scan; the DI scan is #244 from
   2026-10-04/05. ADR-0068 deferred sharing an S3 client until a third user;
   ADR-0194 accepted only one shared pure raster primitive at
   `src/common/image/raster-image.ts`. Neither licenses removing application
   ports. #677's "core reached through a port and token" criterion is met.

9. **Errors.** The core raises neutral domain errors with a reason enum. Each
   feature maps those reasons to its own codes at the presentation boundary;
   the core holds no table of Avatar, Speaking, or Writing error codes.

10. **Migration and scope.** The Writing-chart tracer bullet is the first
    slice, then Avatar, then Speaking. Avatar's migration requires an explicit
    amendment to ADR-0068 decision 6, which rejected a pending row between the
    two calls; #676 does not amend that record now. Comment 6743987656 on #677
    ("only the service layer is unified") is superseded on the boundary point:
    the core owns orchestration and ports, adapters remain per feature. #2010
    is a separate Writing-only contract change, blocked by #677, and is outside
    this decision. #677 keeps observable caller behavior unchanged.

11. **Gates.** `bun run arch-check` and `bun run check:imports` stay compatible
    because every cross-module edge ends at a module file, an application port,
    a `public/` facade, or a Nest export. Migration must **move** files into
    `src/modules/uploads/` rather than add to `speaking/application/audio`
    (already 16/20 entries). The 500-code-line and 20-entry ceilings are not
    raised.

## Considered and rejected

- **Kernel zero-copy streaming** (`stream.pipeline`, `splice(2)`/`sendfile(2)`)
  from comments on #676: rejected. It contradicts ADR-0070, ADR-0068, and
  ADR-0100, where client bytes bypass AIHUB.
- **Claim Check metadata decoupling with asynchronous verification**: rejected
  in favour of ADR-0070's atomic completion and the glossary status set. Queues
  carry job identifiers, not payloads.
- **A shared S3 client / removal of DI ceremony**: rejected by ADR-0073 and
  ADR-0068; only the pure raster primitive is shared per ADR-0194.
- **A shared SHA-256 field on the session record**: deferred to #2010 as
  Writing policy, not a cross-feature invariant.
- **Hosting the core in Gateway or `src/common`**: rejected by the module rules
  and `no-avatar-gateway-import`.

## Consequences

- #677 can proceed with Writing as the vertical cut without changing caller
  assertions; Avatar and Speaking follow as separate migrations.
- Avatar's pending-row conflict is recorded, not silently resolved.
- The body of #676 remains stale on ADR-0066 and `pnpm`; this ADR is the
  authoritative correction. Cross-links are added to ADR-0070, ADR-0100,
  ADR-0068, ADR-0069, ADR-0194, and ADR-0195 without rewriting their decisions.

## Update (2026-11-26): Writing's `deleted` published-asset status (#677)

Decision 1 names `expired` as the canonical terminal session state. Writing's
durable published-asset row already uses `deleted` for a published object that
was revoked or aged out, and caller-visible behavior must not change in #677.
The shared core therefore carries `deleted` on its published-asset view while
Writing is the only consumer; `expired` remains the canonical session state.
This is an adapter-facing alias, not a new session transition. A future
migration that unifies the published-asset vocabulary must amend this record
rather than silently rename the row status.
