# ADR-0069: The Avatar is published, not signed

- Status: Accepted
- Date: 2026-10-02
- Related issue: [#216](https://github.com/AiHub-Ecosystem/aihub-be/issues/216)
- Related: [ADR-0060](0060-writing-task1-sample-image-is-published-not-signed.md), [ADR-0068](0068-avatar-is-a-user-account-owned-asset.md), [ADR-0065](0065-aihub-owns-audio-asset-catalog-and-playback-urls.md)

## Context

The Customer Web shows an account's Avatar ([CONTEXT.md](../../CONTEXT.md))
wherever that account appears. ADR-0068 put Avatars in their own private
bucket, so reading one would need a presigned URL minted by AIHUB: either an
extra round trip on every page that renders it, or a URL that changes each time
it is minted, which defeats caching.

ADR-0060 met the same question for the Writing Task 1 sample image and
published it, because nothing about that image needed to stay confidential. An
Avatar is the same kind of thing: an image shown to identify someone, not a
sensitive asset.

## Decision

1. The Avatar bucket allows anonymous read of objects and denies listing. An
   Avatar is read with a plain unauthenticated `GET` of
   `https://s3.wispace.app/{bucket}/{object key}`, and AIHUB never proxies,
   downloads, or buffers the bytes. This replaces ADR-0068's private-bucket
   clause; the bucket is still separate from the private Speaking sample
   bucket and from the shared WISPACE bucket ADR-0060 uses.
2. AIHUB returns that URL, built from its validated storage settings, in every
   Avatar description: the completion response and `GET /v1/me/avatar`. An
   account with no Avatar answers `avatar: null`, without touching storage.
3. Every upload binds `Cache-Control: public, max-age=3600` into its
   signature, so storage serves it on every read. Each upload has a new asset
   id and therefore a new URL, so no cache shows an old image under a current
   Avatar.
4. The URL is unguessable enough: it embeds the asset id, whose ULID carries 80
   random bits, and listing is denied. Knowing an account id does not reveal
   its Avatar.
5. Only the account's own Avatar is returned, through its own session.

## Consequences

- No URL minting per render, and a stable URL the browser can cache.
- The anonymous read grant is a per-bucket S3 policy that allows
  `s3:GetObject` for any principal and nothing else, the same mechanism the
  public WISPACE buckets (`ielts-task1`, `aihub-audio`) already use. It is set
  through the S3 API with the existing SeaweedFS identity, so it needs no change
  to the host's `s3.json` and no one outside the team. ADR-0060 and this
  ADR's first draft assumed `s3.json` had to change; it does not. Until a
  bucket carries the policy, its images answer `403` and the Customer Web shows
  its username fallback; the API is correct either way.
- The grant is checked by hand, as ADR-0060's was: an anonymous `GET` of an
  Avatar answers `200` with the cache header, an anonymous list of the bucket
  answers `403`, an anonymous write or delete answers `403`, and a Speaking
  sample object still answers `403`.
- Verified on 2026-10-02 against both Avatar buckets, from outside the network:
  SeaweedFS stores `Cache-Control: public, max-age=3600` from the upload and
  serves it back on every read, and each of the checks above held. Whether it
  enforces a signed `Content-Length` is still untested; completion's own check
  of the stored object is what guarantees the size.
- A removed or replaced image can stay in caches for up to an hour. Removal
  deletes the object at the origin at once; it cannot recall copies.
- Anyone holding an Avatar URL learns its owner's account id, because the key
  layout of ADR-0068 contains it. Today the URL only reaches its owner.
  Any slice that shows one account's Avatar to another must first stop
  exposing the account id, by changing the key layout or otherwise, because
  the membership roster deliberately hides account ids.

## Considered options

- **A presigned read URL in each description.** Rejected: a new URL per
  mint defeats caching, and signing protects nothing an Avatar needs
  protected. It would avoid the cache window and the public bucket, which
  is why this was the close alternative.
- **Proxying the image through AIHUB.** Rejected for the reason ADR-0060 and
  ADR-0065 give: it makes the gateway a media server.
- **A long cache lifetime marked immutable.** Rejected: a removed image could
  stay visible for a day or more, which is a poor answer to someone removing a
  picture of themselves.
- **No cache header.** Rejected: browsers would cache by heuristic, with no
  bound anyone can state.
