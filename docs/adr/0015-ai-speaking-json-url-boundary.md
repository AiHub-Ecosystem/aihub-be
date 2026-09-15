# ADR-0015: AI Speaking JSON-by-URL boundary

- Status: Accepted
- Date: 2026-09-15
- Related issue: [#28](https://github.com/lengocanh2005it/aihub-be/issues/28)

## Context

AI Speaking exposes a second synchronous grading transport that accepts an
audio URL. AIHUB needs to expose that fallback without turning an arbitrary
client URL into a server-side fetch primitive or creating a second public
response vocabulary. The multipart Speaking proxy and the future asynchronous
Speaking grading job are already separate contracts.

## Decision

1. Expose `POST /v1/ielts/speaking/grading-json` and forward only to the fixed
   downstream operation `POST /api/v1/speaking/grading-json`.
2. Accept `audio_url`, `part`, and `question_id` as required public fields.
   `test_type` defaults to `Practice`; `prompt_text`, `test_code`, and
   `transcript` are optional and may be `null`. `user_id` is never a public
   field; AIHUB derives it from the verified User Assertion.
3. An approved audio URL is HTTPS on the exact host `storage.wispace.vn`, with
   the default HTTPS port only. Query parameters are allowed for signed object
   URLs. Credentials, fragments, other schemes/hosts/ports, and URLs longer
   than 2,048 characters are rejected before dispatch.
4. AIHUB validates the URL but does not download or proxy the audio. AI
   Speaking owns URL retrieval, redirect handling (no redirects), the 25 MiB
   downloaded-audio ceiling, and completion within the shared 30-second
   operation deadline. These are integration preconditions, not client-
   controlled provider details.
5. The JSON transport uses the same normalized `{data, meta}` response as
   multipart grading. Provider-only identifiers and `performance_timing` are
   dropped; the existing redacted Speaking response fixture is the common
   response-shape evidence for both transports.
6. The route remains synchronous D2 work and does not alter the asynchronous
   `POST /v1/speaking/grade` asset/job contract.

## Consequences

- Signed object URLs work through query parameters without allowing arbitrary
  hosts, local targets, embedded credentials, or redirect-based expansion.
- The gateway remains a routing and trust boundary; it does not buffer or
  inspect provider-downloaded audio.
- Provider URL-fetch behavior must stay within the stated preconditions, and a
  provider contract change requires a new approved fixture and review.
- OpenAPI and Postman remain generated from the operation catalog and the
  normalized response schema remains shared with multipart grading.

## Rejected alternatives

- Accepting any HTTP/HTTPS URL, which would make the gateway contract an SSRF-
  shaped fetch capability.
- Downloading the URL in AIHUB, which duplicates provider retrieval and expands
  gateway memory, timeout, and content-validation responsibility.
- Following redirects, which would defeat an exact-host allowlist unless every
  hop were independently revalidated.
- Accepting a client `user_id`, which would cross the verified-identity trust
  boundary.
- Publishing the old unnamespaced `/v1/speaking/grading-json` alias, which
  would diverge from the canonical IELTS route namespace.
