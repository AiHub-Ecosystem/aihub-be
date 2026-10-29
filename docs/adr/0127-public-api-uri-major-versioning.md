# ADR-0127: Public API major versions use URI paths

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-10-26 in [#1295](https://github.com/AiHub-Ecosystem/aihub-be/issues/1295).
- Date: 2026-10-26
- Related: [ADR-0112](0112-public-api-stays-openapi-trpc-declined.md), [#290](https://github.com/AiHub-Ecosystem/aihub-be/issues/290), [#461](https://github.com/AiHub-Ecosystem/aihub-be/issues/461), [#473](https://github.com/AiHub-Ecosystem/aihub-be/issues/473), [#610](https://github.com/AiHub-Ecosystem/aihub-be/issues/610), [#1259](https://github.com/AiHub-Ecosystem/aihub-be/issues/1259), [#1295](https://github.com/AiHub-Ecosystem/aihub-be/issues/1295)

## Context

AIHUB's customer API is REST and publishes an OpenAPI contract generated from source, as recorded in ADR-0112. Production currently serves the whole Public API under `/v1`. The Integration Guide promises that clients tolerate unknown response fields, while the generated response object schemas mark `additionalProperties: false`; schema-driven clients can therefore reject a response that the compatibility promise allows. Request bodies also use closed schemas, intentionally rejecting unknown fields.

Issue #290 tracks a public contract version and customer-facing changelog. Issue #1259 explores date-header Schema Lenses as an alternative version selector. AIHUB needs one major-version policy that keeps existing `/v1` customers working through incompatible contract changes and aligns the published schema with the customer promise.

## Decision

- The Public API Major Version covers the whole Public API Contract, including dispatch and non-dispatch Public API Routes. Operational health probes are outside that contract. The URI path is the only public major-version selector: `/v1`, `/v2`, and later major paths. A client may use supported majors per request during the transition window.
- Keep `/v1` as the current contract. Compatible additions stay in the current major. Introduce the next major only for a concrete breaking contract change; do not publish an identical `/v2` surface just to advance the number. A breaking change includes removing or renaming an existing route or field, changing an existing field's type or meaning, narrowing accepted request values, making a request field required, removing a response enum value, or adding a value to a closed response enum.
- Use SemVer for the Public API Contract Version in OpenAPI `info.version`, independently of the backend package version. Establish the current `/v1` contract baseline as `1.0.0`; compatible contract additions increment the minor version, and documentation-only contract changes increment the patch version. A new URI major starts at its matching SemVer major, so `/v2` starts at `2.0.0`.
- Publish an immutable OpenAPI document per supported major at `/openapi/vN.json`. Keep `/openapi.json` as an alias to the newest major and provide a version selector in `/docs`. `CHANGELOG.md` is the canonical customer-facing changelog and the Integration Guide links to it.
- Public response object schemas are extensible, including nested envelope, `data`, `meta`, and resource objects. The published OpenAPI contract must allow additional response properties so schema-driven clients can follow the promise to ignore fields they do not recognize. Request body schemas remain closed. New optional request fields are compatible when existing callers can omit them; AIHUB documents them for customer use only after both the deployed release and its normal rollback target accept them.
- The normal rollback target is the immediately preceding successful release. A rollback to an older image requires a reviewed, migration-specific plan that prevents clients from sending fields the target does not support. An intentional-break declaration alone does not permit a breaking change to remain in a supported major; the change belongs in the next major while the prior supported contract remains available.
- When a successor major is released, keep the preceding major available for at least 12 months and publish its sunset date with the successor release. Before sunset, review customer traffic and contact affected customers. If customers are still migrating, an explicit owner decision may extend support; publish the revised date. After sunset, requests to the retired major return `410 Gone` with the standard error envelope and successor information.
- Use the URI path, not a date-version header, to select a public API major. The general Schema Lenses pipeline in #1259 is not adopted for public API versioning; reconsider it only if a concrete contract migration needs that transformation.
- The compatibility gate allows additive response properties on extensible response objects and compatible optional request additions. It still blocks breaking changes within a supported major, including field removals or type changes and additions to closed response enums. A new major requires its versioned OpenAPI contract, changelog entry, and migration notice while preserving the prior supported contract.

## Consequences

Customers can keep using `/v1` while adopting a successor major at their own pace. No `/v2` runtime route is introduced by this decision; the first `/v2` migration is tied to a specific breaking contract change. The OpenAPI response schemas and compatibility gate need implementation work to match this policy; issues #1296 and #1297 track the release artifacts and CI enforcement. The rollback runbook must follow the normal-target rule before customers are told to send a newly added optional request field.

## Confirmation

Approved by AIHUB owner @lengocanh2005it on 2026-10-26 in #1295. This decision selects the public API compatibility policy; it does not by itself implement or deploy `/v2`.

### Update: retirement evidence (#1376, 2026-10-29)

The sunset clause above says to review customer traffic and contact affected customers, but not what evidence counts or who signs. This update settles that without changing the 12-month minimum or the extension rule.

- The sunset date stays fixed once published. Usage evidence decides whom to contact and informs the owner's extension decision; it does not have to prove zero traffic. A major is retired when every Active Consumer has been contacted and the Public API owner has signed off, even if some traffic remains. Requiring proof of zero traffic was rejected because one customer who never migrates would keep a major alive indefinitely, which the "may extend" wording already declines.
- An Active Consumer is an Organization with at least one authenticated request, successful or failed, to the major in either Environment during the 90 days before sunset. A failing caller still depends on the major and breaks at `410`. Ninety days covers one quarterly usage cycle. The initial notice goes to every Organization recorded for the major across the whole support window.
- `coverage_start_day` alone does not prove continuous collection. A process keeps counts a failed write could not store and writes them with the next, so it loses counts only when it dies before writing them. Each process records the time it has written everything up to. A stretch of at most 5 minutes that no process covers is the bounded loss an unclean exit leaves while a replacement starts; it is accepted when it is reported, because an active caller cannot hide in a few such stretches across 90 days. A longer stretch makes every day it touches inconclusive for that Environment, whether it was lost counts or an outage, as do the days before collection was first recorded. Inconclusive evidence is never read as zero traffic: every Organization that Environment ever recorded for the major is treated as an Active Consumer. Each Environment is judged separately, and both share one sunset date.
- Unattributed requests do not block a sunset, because no Organization can be contacted for them, but the owner explains them before signing. The report breaks them down by caller kind. The owner confirms that Customer Web has moved to the successor major, and records the remainder (for example failed API-key authentication) in the sign-off. For those callers, the `Deprecation` and `Sunset` headers (#1362) are the only notice.
- The Public API owner signs each retirement on a public retirement issue. That issue carries only aggregate figures per Environment: Active Consumer count, request totals, unattributed totals by caller kind, and inconclusive days. Organization lists and the outreach log stay private with the operator's report output, because the repository is public.
- An operator emails the active `owner` members of each Organization by hand: every recorded Organization at the successor release, then the Active Consumers at 90 and 30 days before sunset. The final report and owner sign-off happen 7 days before sunset. No automated outreach channel is built.
- An extension needs a contacted Active Consumer that says it is still migrating, plus an owner decision. Each extension is at most 3 months and needs its own decision; there is no overall cap. The revised date is published in the `Sunset` header and documentation, and the procedure restarts from its 90-day step. An Active Consumer that does not reply after both reminders is not a reason to extend.
- Brownout is not part of this procedure; the brownout update below defers it. The procedure is in `docs/operations/public-api-major-adoption.md`, the report and its completeness signals are #1366 and #1389, and runtime retirement is #1367.

Approved by AIHUB owner @lengocanh2005it on 2026-10-29 in [#1376](https://github.com/AiHub-Ecosystem/aihub-be/issues/1376).

### Update: brownout deferred (#1379, 2026-10-29)

A brownout deliberately fails or degrades requests to a major before its sunset, so that a consumer who ignored every notice breaks briefly rather than for good at `410`. AIHUB defers it: no brownout is part of retirement, and production traffic is unchanged.

- No successor major exists yet (#1374 waits for an approved breaking change), so any traffic selection, schedule, impact limit, or abort rule written now would be a guess about a retirement that has not been planned. Brownout also breaks paying customers on purpose, which needs safeguards that are worth building only for a real retirement.
- The existing signals are sufficient for attributed callers: the `Deprecation` and `Sunset` headers (#1362), the per-Organization adoption report and its completeness verdict (#1366, #1389), and the three manual emails of the retirement procedure (#1376). Inconclusive evidence already widens the Active Consumer set to every Organization ever recorded.
- Unattributed callers receive only the headers. Brownout would not reach them either: no Organization can be contacted, and a failed API-key caller is already failing.
- Revisit when either happens: a retirement issue is open and an Active Consumer has replied to neither email by the 30-day step, in which case the owner decides for that retirement and any brownout needs its own implementation and release issue with verified safeguards; or a customer reports breaking at a sunset without having seen any notice. There is no scheduled review.
- Runtime retirement and the `410` response stay in #1367.

Approved by AIHUB owner @lengocanh2005it on 2026-10-29 in [#1379](https://github.com/AiHub-Ecosystem/aihub-be/issues/1379).
