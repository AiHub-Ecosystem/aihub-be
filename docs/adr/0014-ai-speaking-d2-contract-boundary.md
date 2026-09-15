# ADR-0014: AI Speaking D2 contract boundary and evidence

- Status: Accepted
- Date: 2026-09-14
- Related issues: [#24](https://github.com/lengocanh2005it/aihub-be/issues/24), [#25](https://github.com/lengocanh2005it/aihub-be/issues/25), [#27](https://github.com/lengocanh2005it/aihub-be/issues/27)

AIHUB treats Speaking D2 as a synchronous `Speaking grading proxy` at `POST /v1/ielts/speaking/grading`, separate from the future asynchronous `Speaking grading job` at `POST /v1/speaking/grade`; the executable schema and generated artifacts remain the runtime source of truth, the approved TSD is the human-facing contract, and the redacted fixture is the evidence boundary. The proxy keeps a 25 MiB total multipart wire-body ceiling, server-derived downstream identity, no idempotent replay, and shared error mapping. Because the Dev endpoint was unavailable, the authenticated Production smoke accepted in #24 is the Dev-compatibility gate substitute; AI Speaking service/WISPACE approval was confirmed on 2026-09-14. This preserves a testable D2 handoff without silently converting it into the async public API or weakening the no-guessing boundary.
