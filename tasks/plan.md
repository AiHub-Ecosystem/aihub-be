# Implementation Plan: Issue #467 — TOTP second factor

## Overview

Add optional account-level TOTP MFA to local password login and Customer Web BFF login. Enrollment and removal require fresh proof, recovery codes are single-use hashes, and factor-change notices use the existing transactional email outbox. GitHub issue [#467](https://github.com/AiHub-Ecosystem/aihub-be/issues/467) is the task list and acceptance checklist; this repository plan does not duplicate it in `tasks/todo.md`.

## Architecture decisions

- Keep the feature inside `src/modules/auth/`; the separate Identity module owns API-key authentication and user assertions.
- Store TOTP secrets as AES-256-GCM ciphertext. Load the keyring from a dedicated `auth-mfa` Vault bundle and separate rendered file, leaving the existing strict runtime-secret document unchanged. Retain old key IDs while ciphertext still uses them.
- Store recovery codes as SHA-256 hashes and consume each code atomically with session creation.
- Do not create a Refresh Session or Web Session until a valid TOTP or recovery code is verified. Wrong factor and wrong password both return the existing generic credential error and consume the existing login limits.
- Add two bounded Email Delivery Request kinds for factor-enabled and factor-removed notices. PR #489 is already deployed and makes N-1 skip unknown kinds while continuing the rest of the outbox batch.
- Add a Customer Web BFF contract section covering the second login step. Do not change the Customer Web repository in this issue.

## Task list and order

### Phase 1: Contracts and MFA policies

- [x] Extend login and Web Session request/response contracts for the second-factor step: a correct password without MFA returns `202 MFA_REQUIRED`; the second request resubmits email/password with a TOTP or recovery code. Customer Web keeps the password only in transient form memory.
- [x] Add TOTP generation, verification, recovery-code generation/hash policy, proof validation, and focused unit tests.
- [x] Add factor enrollment, confirmation, and removal application use cases behind Auth-owned ports.

### Phase 2: Durable auth state

- [x] Add additive migrations for encrypted factor state and one-time recovery-code hashes.
- [x] Make factor proof consumption atomic with Refresh Session or Web Session creation.
- [x] Revoke durable Refresh Sessions and Web Sessions when a factor is removed.
- [x] Add repository specs and database-lane coverage for races, replay, recovery-code use, and rollback.

### Phase 3: HTTP, BFF, and notifications

- [x] Add Bearer-protected enrollment/removal routes; disclose the TOTP secret only during setup and recovery codes only after successful confirmation.
- [x] Gate both local login and BFF Web Session creation; add HTTP tests proving no session is created before factor proof.
- [x] Add two notification email kinds, encrypted outbox payloads, Resend templates, and tests that messages contain no factor secret or recovery code.
- [x] Document the BFF second step and regenerate OpenAPI/Postman from source.

### Phase 4: Vault and release evidence

- [x] Add the separate Vault bundle, runtime-secret validation, least-privilege policy, and production runbook provisioning/rotation instructions.
- [x] Record the MFA decision in an accepted ADR, including key retention, generic failures, and the remaining 15-minute lifetime of already-issued access JWTs.
- [x] Run focused tests, `pnpm type-check`, `pnpm arch-check`, then `pnpm verify`; review logs and diffs for secret leakage.
- [ ] Merge the writer release only after the MFA Vault bundle is provisioned. Use a disposable, verified test account for the live Sandbox enrollment so #484 can observe a real new outbox kind before rollback.

## Risks and prerequisites

| Risk                                                                     | Mitigation                                                                                                                   |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| A previous image rejects added keys in the main runtime-secret JSON      | Render the MFA keyring to a separate file and add a new path; do not mutate the strict existing document.                    |
| Old readers encounter new outbox `kind` values                           | Keep #489 deployed first; its unknown-value reader skips those rows without failing neighboring deliveries.                  |
| A removal cannot revoke already-issued stateless access JWTs immediately | Revoke durable Refresh/Web Sessions; document and test the existing 15-minute access-token ceiling.                          |
| Live rehearsal needs a verified account and mailbox                      | Do not enroll the operator's own account. Obtain or create a disposable Sandbox test account before recording #484 evidence. |

## Confirmed design choice

The user approved the BFF flow that returns `202 MFA_REQUIRED` after a correct password and has the browser submit email, password, and factor code again. This avoids a durable login-challenge table; Customer Web must keep the password only in transient form memory. Incorrect password and incorrect factor proof both return `AUTH_CREDENTIALS_INVALID`.

## Verification status

- `pnpm verify` passed: 210 suites and 2,081 tests, build, architecture/import checks, migrations, and OpenAPI validation.
- The PostgreSQL database lane was not run: no local PostgreSQL server was listening and the Docker Desktop engine was unavailable.
- The MFA Vault bundle has not been provisioned. Do not merge/deploy the writer or run the Sandbox rollback rehearsal until the bundle is ready and a disposable verified Sandbox account/mailbox is available.
