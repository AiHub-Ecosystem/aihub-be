# ADR-0021: Customer Web Speaking sandbox boundary

- Status: Accepted (identity clauses amended by ADR-0046)
- Related issue: #61

## Amendment for issue #94 (ADR-0046)

Only the identity clauses change: Live grading is gated by active AIHUB Organization Membership evaluated by the BFF at the #94 cutover (Clerk-gated until that moment). Every non-identity invariant in this ADR — no-store grading, pass-through audio, the 90-second outer timeout, safe error mapping, correlation IDs, renderer normalization — remains in force unchanged; that is exactly why ADR-0046 amends rather than supersedes this record.

The separate Next.js Customer Web exposes one `/speaking` surface with an anonymous Mock preview and membership-gated Live grading (Clerk-gated until the #94 cutover). It owns the initial seven-prompt Speaking catalog and sends only authenticated multipart Practice attempts through a server-side Customer Web BFF to AIHUB's sandbox `/v1/ielts/speaking/grading` route; Mock and Live grading share a renderer for a local normalized fixture or the public `{ data, meta }` result, while provider-only identifiers and timing, credentials, assertions, audio, and raw downstream bodies never reach the browser. The first slice keeps upload and browser recording as pass-through audio, excludes object storage and JSON-by-URL transport, keeps failed audio in Step 2 for explicit user retry only, reports a safe error with an upstream request ID when available, and uses an outer 90-second timeout so the browser does not pre-empt the approved D2 deadline or upload/response transit. The BFF preserves AIHUB's public error status/code/message/request ID and maps only local failures; it fails closed for non-sandbox hosts, validates the normalized envelope before rendering, marks live requests no-store, and carries correlation IDs without caching or persisting audio. The UI remains bilingual, and microphone denial degrades to upload rather than blocking the demo.
