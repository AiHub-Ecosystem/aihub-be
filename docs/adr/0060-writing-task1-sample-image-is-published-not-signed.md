# ADR-0060: The Writing Task 1 sample image is published, not signed

- Status: Accepted
- Related issue: [#189](https://github.com/AiHub-Ecosystem/aihub-be/issues/189)
- Related: [ADR-0015](0015-ai-speaking-json-url-boundary.md)

Writing Task 1 grading requires an `image_url` for the chart the submitted
essay describes. The AI Writing service retrieves that image itself, outside
the customer's request, so nothing in the retrieval can be authenticated: a
signed URL expires before the provider fetches it, and a credential cannot be
attached to a fetch AIHUB does not perform. The sample image is therefore
published — a plain unauthenticated GET returning the image bytes — and not
signed.

The image lives in the SeaweedFS bucket `ielts-task1` on the
`s3.wispace.app` origin already approved for Speaking
([ADR-0015](0015-ai-speaking-json-url-boundary.md)), reachable at
`https://s3.wispace.app/ielts-task1/ca95bd4ab522946d`. That bucket is
distinct from `aihub-speaking-samples`, which holds the Speaking sample audio
and stays private: those objects are read only through short-lived signed URLs
(`SPEAKING_AUDIO_URL_TTL_SECONDS`, 15 minutes) minted by
`S3SpeakingAudioStorage`. The two asset classes share one origin and are
separated by bucket, not by host.

The `s3.wispace.app` origin therefore serves two trust levels at once. This
extends ADR-0015's scope of that host; it does not amend any clause of it.
ADR-0015 constrains which _audio_ URLs the gateway accepts, and nothing here
loosens that boundary. The host is not a trust boundary — the bucket is.

Verified on 2026-09-28 from a client outside the AIHUB network: an
unauthenticated `GET` of the sample URL returns `200` with
`Content-Type: image/png`; the same request against an `aihub-speaking-samples`
object returns `403`; and the sample chart matches the Task 1 question and
essay used by the Postman collection and the captured grading fixture.

## Considered options

- **A signed URL for the sample image.** Rejected: the provider's retrieval
  happens outside the customer's request, so a short-lived signature either
  expires first or must be long-lived enough to stop being a control at all.
  This is the same constraint that makes Speaking audio signed and Task 1
  images signed differently in the first place.
- **Proxying the image through AIHUB.** Rejected: it would make the gateway
  responsible for retrieving, buffering, and validating an image it does not
  interpret, widening gateway responsibility for no gain.
- **Requiring the customer to host their own chart.** Rejected: it makes
  AIHUB's own sample request unrunnable, which is the gap this decision closes.
- **A separate, explicitly public bucket for AIHUB's writing samples.**
  Rejected for now: SeaweedFS grants no access to buckets that `s3.json` does
  not declare, and a newly created bucket is private by default. Publishing one
  means editing the shared host's S3 config, which is WISPACE's to change. The
  existing public bucket already serves the sample, so a new bucket buys
  isolation the current arrangement does not yet need.

## Consequences

- The Task 1 sample URL is stable and may be published in documentation,
  tests, and the Postman collection. It is a fixture, not a secret.
- Object keys in `ielts-task1` are content-addressed hashes, so the published
  URL is reproducible but not self-describing. Renaming one would break the
  Postman collection, the grading fixture, and the public contract document at
  once, so the opaque key is kept.
- `ielts-task1` is a shared WISPACE bucket holding 340 objects, not an
  AIHUB-owned one. This decision does not claim it as ours, and any change to
  its read access is a WISPACE-side change.
- Anyone who can reach the origin can read every object in `ielts-task1`. That
  is the accepted cost of publishing the sample, and it is why the Speaking
  bucket must remain a different bucket.

## Correction (2026-10-02)

The fourth considered option above says a separate public bucket needs an edit
to the host's `s3.json`, which is WISPACE's to change. That is not how the
public buckets are published. `s3.json` declares one identity and no anonymous
one; public read comes from a per-bucket S3 policy allowing `s3:GetObject` for
any principal, stored on the bucket and set through the S3 API with the
existing identity. `ielts-task1`, `ielts-task1-storage`, `aihub-audio`, and
`wispace` carry such a policy, and `aihub-speaking-samples` carries none, which
is why it stays private. A new public bucket therefore needs no change to the
shared host's configuration. [ADR-0069](0069-avatar-is-published-not-signed.md)
uses this for the Avatar buckets.
