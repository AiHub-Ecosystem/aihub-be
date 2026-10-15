# ADR-0101: Serve Writing Task 1 charts from the shared SeaweedFS host

- Status: Accepted
- Date: 2026-10-15
- Related issue: [#580](https://github.com/AiHub-Ecosystem/aihub-be/issues/580)
- Amends: [ADR-0100](0100-writing-task1-chart-image-uploads.md), specifically its dedicated-host decision and rejection of the shared S3 origin

## Context

The existing customer-facing SeaweedFS S3 host is `https://s3.wispace.app`.
It already serves public media through path-style URLs such as
`https://s3.wispace.app/ielts-task1/<object-key>`. DNS resolves to the AIHUB
storage VPS, and a read-only HEAD request confirmed the supplied example path
returns the image from that host.

ADR-0100 originally chose a separate registrable domain for chart delivery to
isolate chart hosting reputation and blocklist risk from existing public media.
The product owner has chosen to reuse the existing S3 host for chart images.

## Decision

Use `https://s3.wispace.app` as the public URL base for both Production and
Sandbox chart images. Keep separate staging and public buckets for the two
environments. Published URLs include the matching public bucket path:

- Production: `https://s3.wispace.app/aihub-writing-charts/<object-key>`
- Sandbox: `https://s3.wispace.app/aihub-sandbox-writing-charts/<object-key>`

Staging buckets remain private. Each public chart bucket permits anonymous
`GetObject` only; anonymous listing, writes, and deletes remain denied. AIHUB's
storage identity retains the writes and deletes required for publication and
retention cleanup. No chart hostname or separate nginx route is introduced.

## Consequences

- This explicitly accepts shared-host reputation and blocklist risk for chart
  content alongside existing WISPACE media.
- Environment isolation continues to depend on separate bucket names and
  per-bucket S3 policies, rather than separate hostnames.
- The host's availability and TLS serve both existing media and chart URLs.
- All other upload eligibility, validation, quotas, retention, public exposure,
  abuse-reporting, and provider-fetch requirements in ADR-0100 remain in force.
- The separate provider URL-fetch security gate in #376 remains a release
  blocker.
