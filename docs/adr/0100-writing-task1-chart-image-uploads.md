# ADR-0100: Upload Writing Task 1 chart images for authenticated callers

- Status: Accepted
- Date: 2026-10-14
- Related issue: [#580](https://github.com/AiHub-Ecosystem/aihub-be/issues/580)
- Amends: [ADR-0099](0099-writing-task1-charts-remain-caller-hosted.md), which declined chart uploads
- Related: [ADR-0084](0084-writing-task1-public-image-fetch-boundary.md), [ADR-0070](0070-speaking-audio-upload-intent-and-retention.md), [ADR-0060](0060-writing-task1-sample-image-is-published-not-signed.md), [ADR-0018](0018-monthly-quota-enforcement.md), [ADR-0056](0056-customer-sandbox-test-tier.md), [ADR-0095](0095-demo-environments-and-sandbox-allowance-policy.md), [#376](https://github.com/AiHub-Ecosystem/aihub-be/issues/376), [#568](https://github.com/AiHub-Ecosystem/aihub-be/issues/568)

## Context

Writing Task 1 currently accepts an `image_url` that the AI Writing service
fetches without customer credentials. ADR-0084 requires a public HTTPS URL and
limits the provider fetch to 10 MiB and 10 seconds. A caller with only a local
chart file cannot use the current API without hosting that file first.

The product now allows customer chart uploads. The upload must preserve the
existing provider fetch contract while keeping unauthenticated visitors out of
the upload surface and bounding public storage exposure and cost.

## Decision

**Eligibility and ownership.** Upload is available only to authenticated Live
callers whose API key has the `writing.grade` scope. The upload and completion
requests use the same validated End User identity policy as Writing Task 1
grading: an Organization may use its existing declared or signed identity mode.
Each asset is bound to its Organization, End User, and API-key environment; a
matching context is required to complete the upload. The anonymous, no-key demo
remains a fixed Mock preview.

**Upload flow.** The client requests a short-lived upload URL, sends the image
directly to object storage, then completes the upload through AIHUB. Completion
returns the published HTTPS URL for the existing `image_url` grading field.
The storage POST policy binds the exact declared byte size, so oversized or
mismatched bodies are rejected before storage accepts the file. AIHUB does not
proxy image bytes through the grading API.

**Public delivery.** Customer chart images use a dedicated chart hostname and
dedicated storage bucket, on a registrable domain separate from the API domain
and `s3.wispace.app`. It is separate from the WISPACE-owned `ielts-task1`
sample bucket, Avatar buckets, and Speaking buckets. Sandbox and Production
assets are isolated. An upload is written to private staging; only after byte
and image checks pass may the immutable completed object be published for
anonymous HTTPS reads. An incomplete upload is never publicly reachable. A
later write to a completed object key is rejected.

The published URL remains an ordinary public URL: it has no credentials or
expiring signature. Anyone who learns the URL can read and reuse the image
until it expires. Organization/User ownership scopes upload and completion;
it does not make the published URL private or prevent another caller from
submitting it to grading. This follows ADR-0084 because the AI Writing service
does not send customer authentication on its image fetch.

**Accepted content.** Accept JPEG, PNG, and WebP only. Reject SVG. Compressed
size is at most 10 MiB, matching the provider fetch ceiling, and decoded image
size is at most 20 megapixels. Completion fully decodes and re-encodes the
image before publication, applies EXIF orientation, strips source metadata,
rejects malformed or multi-frame images, and enforces the same 10 MiB limit on
the published bytes. Storage metadata alone is not trusted; this is the image
verification boundary tracked in #568.

**Retention and abuse limits.** Permit at most five new upload intents and at
most five successful publications per Organization in any rolling one-hour
window. Delete each completed chart 24 hours after publication. The publication
limit and TTL bound the public population to at most 120 objects per
Organization. An incomplete upload remains private. Reuse the Speaking upload
intent lifecycle: a one-hour intent deadline, short-lived upload URLs, and
five-minute upload URLs, and orphan cleanup 24 hours after intent expiry.
Staging stays private for that entire period. Uploads do not consume the monthly
grading quota and do not create grading or billing records; this amends the proposed #580
acceptance criterion that would charge the grading envelope. It avoids
changing Production's successful-billable quota semantics or Sandbox's
dispatch allowance. AIHUB absorbs storage cost within these limits.

**Abuse reports.** Publish an AIHUB-controlled email address or web form for
third-party reports of chart content. The response target is within one
business day. The exact public contact must be selected by the responsible
operations/support owner before public rollout; this ADR does not invent one.

## Consequences and boundaries

- The Writing request schema and downstream mapping continue to use
  `image_url`; an uploaded chart is just another URL at that boundary.
- A private-object fetch would require reopening ADR-0084 with the AI Writing
  service owner.
- Provider-side fetch enforcement remains tracked separately in #376. This ADR
  does not claim that implementation is deployed.
- The byte and dimension checks in #568, private staging, immutable publication,
  retention deletion, per-Organization upload limiting, and the dedicated
  chart origin are release requirements. Before rollout, update the personal
  data inventory with the chart contents, Organization/User linkage, public
  exposure, deletion behavior, and any verified backup behavior.
- The exact chart hostname and abuse-report address are deployment/business
  values that must be supplied before public rollout.
- Customer-facing upload guidance must say plainly that completed images are
  public and their URLs are shareable until expiry; callers must not upload
  content they cannot expose publicly.
- This ADR records the accepted product and security decision; it does not
  claim the upload API or Customer Web file picker is implemented.

## Rejected alternatives

- **Anonymous upload:** rejected because it would expose an unauthenticated
  public-hosting surface, while the no-key demo remains Mock.
- **Private object fetch:** rejected for this decision because the current AI
  Writing contract sends no credentials; changing that contract requires
  reopening ADR-0084.
- **Publishing directly from the upload target:** rejected because an uploaded
  but unverified object must not be readable before completion.
- **Charging the grading quota for uploads:** rejected because an upload is
  neither a successful billable grade nor an AI dispatch, and charging both an
  upload and its grading request would use two units for one submission.
- **Reusing the shared `s3.wispace.app` origin:** rejected to isolate chart
  hosting reputation and blocklist risk from existing public media.
