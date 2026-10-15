# ADR-0099: Keep Writing Task 1 charts caller-hosted

- Status: Superseded by [ADR-0100](0100-writing-task1-chart-image-uploads.md)
- Date: 2026-10-14
- Related issue: [#580](https://github.com/AiHub-Ecosystem/aihub-be/issues/580)
- Related: [ADR-0084](0084-writing-task1-public-image-fetch-boundary.md), [ADR-0060](0060-writing-task1-sample-image-is-published-not-signed.md), [#376](https://github.com/AiHub-Ecosystem/aihub-be/issues/376), [#568](https://github.com/AiHub-Ecosystem/aihub-be/issues/568)

Writing Task 1 continues to accept a caller-supplied `image_url` on any public HTTPS host that AI Writing can fetch with an unauthenticated request. This decision declines adding a chart-image upload path to the current product contract: under the accepted fetch contract, an AIHUB upload would still need public reads, bringing retention, deletion, quota, abuse-reporting, and content-verification duties; anonymous upload also would not unlock Live grading, which requires an eligible customer API key. The provider's `api-ielts-writing.aihubproduction.com` host sharing a registrable domain with the API does not let image fetches use credentials; the current public sample and Avatar URLs use the separate `s3.wispace.app` storage origin.

This was the accepted decision before the product scope changed. [ADR-0100](0100-writing-task1-chart-image-uploads.md) supersedes it by allowing authenticated callers to upload a chart that is verified, published on a dedicated public origin, and retained for 24 hours. Its observations about the unauthenticated provider fetch boundary and the independent #376 implementation status remain relevant.
