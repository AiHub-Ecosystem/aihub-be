# ADR-0062: Publish one stable Speaking sample answer copy

- Status: Accepted
- Date: 2026-09-28
- Related issue: [#196](https://github.com/AiHub-Ecosystem/aihub-be/issues/196)
- Related: [ADR-0015](0015-ai-speaking-json-url-boundary.md), [ADR-0060](0060-writing-task1-sample-image-is-published-not-signed.md)

## Context

The approved Part 1 candidate answer already exists in the private
`aihub-speaking-samples` bucket at
`speaking-samples/part-1/do-you-enjoy-living-in-your-city-or-hometown.webm`.
The catalog exposes it with a signed URL that expires after 15 minutes. That
is too short-lived for the copyable `grading-json` sample and its documentation.

## Decision

Keep the private source object and its bucket policy unchanged. Copy only this
recording into the existing shared WISPACE bucket `ielts-task1` at
`speaking-answers/part-1/do-you-enjoy-living-in-your-city-or-hometown.webm`.
Its stable public URL is
`https://s3.wispace.app/ielts-task1/speaking-answers/part-1/do-you-enjoy-living-in-your-city-or-hometown.webm`.
The URL is intentionally accessible by plain HTTPS GET with no signature,
query parameters, or credentials. The bucket's existing public-read policy is
unchanged and remains owned by WISPACE.

The sample request uses the matching Part 1 metadata:
`question_id=p1_do-you-enjoy-living-in-your-city-or-hometown`,
`prompt_text=Do you enjoy living in your city or hometown?`. This is answer
audio, not a recording of the examiner reading the prompt. The
`grading-json` API contract and ADR-0015's host/fetch boundary are unchanged.

## Consequences

- The sample URL is public data, not a secret. Anyone who can reach
  `s3.wispace.app` can fetch it.
- The public copy is in a shared bucket, not AIHUB-owned storage. Do not change
  the bucket-wide policy or publish other recordings as part of this decision.
- A durable unsigned URL lets the copied sample remain runnable after the
  private catalog's 15-minute signature expires.
