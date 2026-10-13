# Bind demo API keys to environments and make Sandbox allowances durable

- Status: Accepted
- Date: 2026-10-13
- Related: [AiHub-Frontend #68](https://github.com/AiHub-Ecosystem/AiHub-Frontend/issues/68), [FE PR #67](https://github.com/AiHub-Ecosystem/AiHub-Frontend/pull/67), [BE PR #602](https://github.com/AiHub-Ecosystem/aihub-be/pull/602), frontend ADR-0018
- Amends: [ADR-0056](0056-customer-sandbox-test-tier.md) for the default Organization Sandbox allowance and monthly overrides; [ADR-0094](0094-sandbox-demo-key-admission.md) for demo environment selection and fresh admission
- Implemented by: issue [#617](https://github.com/AiHub-Ecosystem/aihub-be/issues/617); migration `0037_sandbox_allowance_policy`, `src/modules/gateway/public/sandbox-dispatch-budget.ts`, `src/modules/identity/domain/api-key.ts`

## Decision

This records the accepted design. It is implemented; see the runbook in [`../operations/sandbox-provisioning.md`](../operations/sandbox-provisioning.md) for changing the persisted default and a month-specific Organization override.

New customer API keys are bound to one environment. Their display prefixes are `aihub_sandbox_` and `aihub_prod_`. Key material continues to come from a cryptographically secure random generator with at least the existing 256 bits of entropy; AIHUB stores only a one-way hash and enforces hash uniqueness. A prefix helps a person recognize a key but never grants access. The persisted `allowed_environments` value is authoritative and must contain exactly the selected environment for a new key. Existing `aihub_sk_` keys remain valid under their stored `allowed_environments`, including keys that explicitly allow more than one environment. Existing hashes cannot be rewritten into a new prefix because the raw key is not stored.

The demo explicitly selects Sandbox or Production, defaulting to Sandbox. Validation requires the key's current stored environment and the current page's grading scope to match the selection. A mismatch is rejected and never causes a host switch. The Customer Web BFF chooses only the pinned HTTPS host for that environment and rejects redirects. Validation performs no AI dispatch and consumes no monthly allowance. It may report a current allowance snapshot. Every actual grade independently checks the key, active Organization, environment, scope, identity policy, rate policy, and quota. Demo Production checks must not accept a stale positive authorization result after key revocation, scope change, or Organization suspension. An Organization with active Identity Configuration remains ineligible until its own signed assertion can be supplied; the AIHUB demo assertion signer is not reused for customer Organizations.

Sandbox admission uses a durable policy with a default allowance of five grading dispatches per Organization per UTC calendar month. The same Organization allowance is shared by every API key, client, and Writing/Speaking skill; it is not a demo-only counter. The shared Sandbox ceiling remains 500 dispatches per UTC month. A Sandbox allowance override stores the Organization's total allowance for one specific UTC month, replacing the default for that month rather than adding a bonus. Missing next-month overrides resolve to the persisted default. There is no admin UI in this decision.

The default of five takes effect in the first UTC month after deployment of this policy. The deployment month retains its already-effective Organization allowances and consumed dispatch history; deployment or process restart must not reset counters. Editing an override never resets consumption. Raising an allowance admits only the remaining difference; lowering it below already-consumed usage blocks further dispatches until the next effective allowance permits them. The Production `monthly_request_quota` and Production billing policy are separate and unchanged.

One Sandbox dispatch is consumed at the durable dispatch boundary, immediately before calling the AI service. A downstream timeout or error after that boundary consumes the unit. A failure known to occur before dispatch does not consume a unit; an existing reservation is released if dispatch is known not to have started. Organization and shared-cap admission are atomic with durable reservations, so concurrent requests cannot both take the last available unit. If the policy or reservation store is unavailable, unreadable, or corrupt, grading fails closed; AIHUB must not substitute a permissive default or dispatch without verified admission.

Writing retries use the same idempotency key for the same logical submission and a new key for a new submission. Only a completed successful replay avoids a second Sandbox dispatch. A timeout with an unknown dispatch outcome is not exactly-once delivery and is not refunded. Speaking has no idempotent replay or automatic retry; a user-initiated retry is a new dispatch and can consume another unit.

Public key validation is rate-limited without letting a visitor identified only through an untrusted forwarding header control the limit. The Customer Web BFF applies per-visitor abuse limits using only its trusted ingress proxy chain; the backend does not treat the shared BFF egress IP as a unique visitor identity for that purpose. Request bodies are bounded before full buffering and upstream operations have deadlines. Credentials never appear in URLs, logs, traces, analytics, or error details.

## Consequences and limits

The shared ceiling can be exhausted before some Organizations use their own allowance, so one Organization's valid key is not a promise that another dispatch will be admitted. The shared cap and existing Organization-creation, rate, and concurrency controls limit aggregate abuse; they cannot eliminate abuse through many legitimate Organizations.

Production confirmation is a Customer Web usability safeguard, not a backend spend cap. Production still uses its existing key and quota policy, including its current Redis degraded-mode behavior; this decision adds no USD budget, hard-cost ceiling, or billable-request retry mechanism. A request already dispatched before a credential is revoked may finish; revocation blocks subsequent admissions but cannot undo work already sent downstream.

## Acceptance boundaries

- Validation and grading reject a key whose stored environment or scope does not match the selected demo page; the key prefix alone never authorizes a request.
- Revocation, Organization suspension, scope changes, and activation of Identity Configuration are observed by the next demo grade, including Production.
- At a UTC month boundary, the deployment-month allowance and history remain intact and the next month's default or exact Organization override is applied once.
- Concurrent attempts at the last Organization or shared Sandbox slot admit at most one dispatch; policy-store failure produces no dispatch.
- Validation makes no AI request and consumes no dispatch. A grade that reaches the dispatch boundary consumes one even if downstream fails or times out.
- A completed successful Writing replay consumes no additional unit; Speaking retries are new attempts.
- Validation abuse from one visitor cannot block all visitors sharing the BFF egress address; oversized bodies are rejected before buffering.
