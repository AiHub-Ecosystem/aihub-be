# ADR-0128: Persisted values and Vault document keys are read before they are written

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-10-28 in [#484](https://github.com/AiHub-Ecosystem/aihub-be/issues/484).
- Date: 2026-10-28
- Related: [ADR-0013](0013-vault-runtime-secret-management.md), [ADR-0074](0074-transactional-email-outbox.md), [ADR-0085](0085-per-tier-blue-green-cutover.md), [ADR-0127](0127-public-api-uri-major-versioning.md), [#289](https://github.com/AiHub-Ecosystem/aihub-be/issues/289), [#484](https://github.com/AiHub-Ecosystem/aihub-be/issues/484), [#754](https://github.com/AiHub-Ecosystem/aihub-be/issues/754)

## Context

Migrations are expand-only, so the previous release (N-1) can run against the schema the next release (N) leaves behind. That protects tables and columns, not values. AIHUB's persistence mappers and secret loaders are strict on purpose: a value or key they do not know reads as corrupt or misconfigured. Release N can therefore write a value, or ask for a Vault document key, that N-1 treats as an error, and a rollback to N-1 then stops work that has nothing to do with the change.

Two cases made this concrete. An email outbox row of a kind N-1 did not know failed the whole claim, so verification and password-reset mail stopped for everyone. A payload that gained one member became invalid on the older release, which marked it failed and erased it. For secrets, the runtime-secret and connection loaders reject an unknown document field. The CI N-1 gate boots the previous image against the candidate's documents, so a candidate that adds a document key cannot pass the gate, while the documented held/drained cutover needs the image the gate refuses to publish.

## Decision

- A stored value, claim, payload member, or Vault document key is **read before it is written**. One release teaches the reader to accept it; a later release starts writing it, only after the first is deployed.
- A reader that meets a value it does not know **skips and reports it**, never failing the rows around it. The row stays as it was, so the release that knows the value can still handle it. The report is a bounded metric and a log line that name the kind and carry no payload or secret.
- A reader ignores a payload member it does not know and still refuses a known member of the wrong type. A value of a known enumerated member that it does not know is an unrecognised value: the row is handed back, not failed.
- A new key in a strict Vault document ships reader-first: the loader is taught the key as optional in one release, and the Agent template and rendered document gain it in a later one. The held/drained cutover remains the recorded procedure for the Web Session key, which predates this rule, and is not used for a new key.
- The CI N-1 gate enforces the rule and rehearses it: a row of a kind no release knows must be left queued while its neighbours are dispatched, and an added document key must either be refused by N-1 or tolerated, never printed, with N-1 ready again after its previous document is restored.

## Consequences

Adding a stored value or a document key takes two releases instead of one, and a release that needs both halves at once is split. The strict loaders stay strict: they still reject typos and stray keys, because a key is only ever added to the reader before it is added to a document. A rollback no longer depends on the operator deleting rows or restoring a secret document by hand, except for the historical Web Session procedure.

The rule is not enforced for every possible new value by tooling. The gate probes the outbox and the document shape; each pull request that changes persisted values or runtime configuration still names the old-reader behaviour, as `docs/agents/domain.md` requires.

## Confirmation

Approved by AIHUB owner @lengocanh2005it on 2026-10-28 in #484. The outbox behaviour is pinned by the poller, payload reader and repository specs; the gate probes are `scripts/ci/n-minus-one/n-minus-one-outbox-probes.ts` and `n-minus-one-vault-rehearsal.ts`.
