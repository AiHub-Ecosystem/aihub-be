# ADR-0194: Avatar bytes are re-encoded before publication and every change is audited

- Status: Accepted
- Date: 2026-11-16
- Related issue: [#429](https://github.com/AiHub-Ecosystem/aihub-be/issues/429)
- Related: [ADR-0069](0069-avatar-is-published-not-signed.md), [ADR-0068](0068-avatar-is-a-user-account-owned-asset.md), [ADR-0035](0035-organization-audit-trail-boundary.md), [ADR-0196](0196-one-upload-session-core-serves-avatar-speaking-and-writing.md)
- Amends: [ADR-0069](0069-avatar-is-published-not-signed.md) (the 2026-11-07 private-staging clause: completion now reads and re-encodes instead of copying)

## Context

ADR-0069 publishes an Avatar at a public, cacheable URL, and the 2026-11-07
private-staging clause has completion _copy_ the staging object into that
public key with `MetadataDirective: REPLACE`. Replacing the metadata does not
touch the image itself: a phone photo's EXIF block (GPS, capture time, device
model), its XMP packet, and its ICC profile all live inside the encoded bytes
and survive a server-side copy unchanged. Today only the owner sees the Avatar,
so the exposure is small; ADR-0069 already names "shown to other users" as the
point where that stops being true.

Fixing it in the browser is not an option: the browser writes the staging
object directly, and a client that chooses not to strip is still a client. The
only place that can guarantee the property is the step that turns staging into
the published object.

The same upload also leaves no trace: setting, replacing, or removing an Avatar
writes only the current `user_avatars` row, so nothing says when an image was
published or who removed it (TM-U5).

## Decision

1. Completion decodes the staging object and re-encodes it from pixel data
   before writing the published key. `sharp` already ships for the Writing
   chart-upload sanitizer, so the decode/encode logic lives once in
   `src/common/image/raster-image.ts` and Writing and Avatar both call it. The
   output carries no EXIF, XMP, or ICC profile, and no bytes trailing the
   container. JPEG is written at quality 100 with 4:4:4 subsampling, PNG and
   WebP losslessly, so the visible image is unchanged; `.rotate()` bakes in the
   EXIF orientation that stripping would otherwise lose.
2. Publication therefore becomes `readStagingObject` → `sanitizeRasterImage` →
   `putFinalObject` in place of `copyStagingToFinal`. The read is bound by the
   staging `ETag` that the completion already observed, so a replayed staging
   `PUT` still cannot swap in bytes between the check and the read. Decoding is
   serialized process-wide and bounded by a pixel ceiling (20 MP) because a
   2 MiB JPEG can describe an arbitrarily large bitmap; a re-encode that grows
   past 2 MiB is refused like an oversized upload.
3. Every accepted change writes one `user_avatar_audits` row - account,
   `actor_source`, action (`avatar.set`, `avatar.replaced`, `avatar.removed`),
   asset id, request id, and time - in the change's own transaction, following
   ADR-0035. A change that does not apply (a repeat completion, a lost
   conditional update, a removal that finds nothing) writes no event, because
   the audit answers "what changed", not "what was attempted". The account is
   both target and actor: every Avatar route acts on the caller's own Avatar.
   No image content and no URL is stored; the asset id already names the
   published object.
4. The audit table is append-only by trigger, and its action set and id
   patterns are `CHECK` constraints, as ADR-0035 does for the Organization
   trail.

## Consequences

- Completion does one more bounded read and a decode; the completion deadline
  already wraps the storage calls and the decode is serialized, so a burst of
  completions queues rather than oversubscribing the CPU.
- A file that is not a decodable image of the declared type, or whose container
  is incomplete, is refused as `INVALID_REQUEST` and its staging object is
  discarded. That is stricter than the previous size-and-content-type check,
  and is the point: the server now has to actually decode what it publishes.
- The published `byte_size` is the re-encoded size, not the uploaded size, so
  the recorded Avatar describes the object that is really there.
- The passed-through `Cache-Control` on the upload signature is unchanged; the
  published object gets it again from `PutObject`, since it is a different
  object now.
- Reading the audit trail over HTTP is not part of this change; the table is
  the durable evidence, and a read endpoint can come with the slice that shows
  avatars to other users.
