# ADR-0131: Customers are told when grading behavior changes

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-10-30 in [#1069](https://github.com/AiHub-Ecosystem/aihub-be/issues/1069).
- Date: 2026-10-30
- Related: [ADR-0016](0016-metering-boundary-and-billing-evidence.md), [ADR-0127](0127-public-api-uri-major-versioning.md), [#290](https://github.com/AiHub-Ecosystem/aihub-be/issues/290), [#378](https://github.com/AiHub-Ecosystem/aihub-be/issues/378), [#459](https://github.com/AiHub-Ecosystem/aihub-be/issues/459), [#750](https://github.com/AiHub-Ecosystem/aihub-be/issues/750), [#827](https://github.com/AiHub-Ecosystem/aihub-be/issues/827), [#1069](https://github.com/AiHub-Ecosystem/aihub-be/issues/1069)

## Context

AIHUB sells a band score. The model, prompt, and rubric behind it live in the AI Services, and a change to any of them can move bands for the same input while every response still validates. AIHUB can notice such a drift after the fact (#459), gate adversarial robustness (#378), and measure quality (#827). Nothing decided what a customer is told.

Customers build their own validation sets. Model identity is neither required nor exposed (ADR-0016), so a customer cannot see a change for themselves. The contract changelog (#290) records contract versions, and its release gate requires the newest entry to match the public contract version; a change in grading behavior is not a contract version. The AI Service contracts require a versioned review only for a change of shape, so no one is obliged to warn AIHUB before a change that leaves the shape alone.

## Decision

- **Term.** A _grading behavior change_ is any change to the model, prompt, or rubric and evaluation of an AI Service that can move the bands it returns for the same input, whether or not the response shape changes. It is not a breaking contract change under ADR-0127: it neither bumps the contract version nor starts a new URI major.
- **Upstream duty.** The AI Service owner tells AIHUB before a grading behavior change, with the effective date and the band evidence. The duty is written into section 8 of each AI Service contract. It binds only once the AI Service owner and WISPACE approve that section.
- **Timing.** A planned change expected to move bands past the agreed tolerance (#459) is announced at least 14 days before it takes effect. A smaller planned change, and an urgent correction such as a prompt-injection or scoring fix, is announced no later than its effective date. A shift AIHUB detects without notice (#459) is announced once AIHUB confirms it, with the evidence.
- **Surface.** `docs/grading-changes.md` is the canonical log and the Integration Guide links it. It is not part of `CHANGELOG.md`. For a change announced ahead of time, AIHUB also emails the Organization owner contact, as it does for an incident. Automating that email is tracked in #750.
- **Content.** Each entry gives the effective date, the affected operations, what changed in plain words without a model or provider name, the band-shift evidence (or states that it is not yet measured), and what a customer should re-check in their own validation set.
- **No exposed identity or version.** The stance that model identity is not exposed stands, and so does the absence of a version field in grading responses. An opaque grading revision is a recorded alternative, reconsidered when an AI Service can return one.
- **No pinning.** A customer cannot pin or opt into a grading behavior. AIHUB runs one behavior per operation. Reconsider when a customer needs it and an AI Service can serve several behaviors at once.
- **What AIHUB owes.** AIHUB gives notice as above, gives the evidence on request, and answers through support during its published hours, using the `request_id`. It does not promise stable scores, re-grading of past results, a rollback for one customer, or compensation. When a change proves to be a regression, AIHUB publishes a correction, and the AI Service owner decides whether to roll back for all customers.
- **Roles.** The AIHUB owner owns the policy. The AI Service owner supplies the content and the band evidence. AIHUB publishes and sends. An entry the AI Service owner has not approved is not published.

## Consequences

The policy takes effect for AIHUB at once, but a notice can only be as early as the AI Service owner's own warning, so advance notice is a promise AIHUB can keep only after the section 8 change is approved. Until then AIHUB announces what it learns, when it learns it.

A customer whose validation breaks has a dated record to compare against and a support route, not a promise of stability. Pinning, an exposed revision, and automated email stay out until a concrete need appears.

## Confirmation

Approved by AIHUB owner @lengocanh2005it on 2026-10-30 in #1069. `docs/grading-changes.md` and the Integration Guide state the policy; section 8 of each AI Service contract carries the upstream duty as proposed until the AI Service owner and WISPACE approve it.
