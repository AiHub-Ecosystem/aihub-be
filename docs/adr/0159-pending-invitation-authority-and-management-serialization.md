# ADR-0159: Pending invitation authority lifetime and the management serialization boundary

- Status: Accepted
- Date: 2026-11-09
- Amends: [ADR-0027](0027-organization-membership-and-key-management.md), [ADR-0049](0049-owner-managed-organization-identity-configuration.md)
- Related: [#447](https://github.com/AiHub-Ecosystem/aihub-be/issues/447), [#302](https://github.com/AiHub-Ecosystem/aihub-be/issues/302), [#854](https://github.com/AiHub-Ecosystem/aihub-be/issues/854), [#1040](https://github.com/AiHub-Ecosystem/aihub-be/issues/1040), [ADR-0043](0043-organization-rename-boundary.md), [ADR-0107](0107-user-accounts-read-contract-and-lock-order.md)

## Context

A STRIDE threat model of self-serve Organization management ([#447](https://github.com/AiHub-Ecosystem/aihub-be/issues/447), findings TM-ORG-03 to TM-ORG-05) showed that a member's authority could outlive the event that removed it. ADR-0027 defines recipient and token admission for invitations but does not state whether an inviter's later authority change invalidates a pending grant, and several management mutations decided the caller's role before their transaction and re-read only the Organization status inside it. A disable, demotion, or ownership transfer that committed while such a request waited left the request free to complete: a disabled admin could rotate an API key and receive a fresh credential, and an open owner invitation could still convert its recipient into an owner after the inviter had transferred ownership away. API keys recorded no creator or last rotator, so a removed manager's keys were live and unattributed, and the `organization.identity_config_set` audit event recorded only the issuer and key source, leaving no record of which public keys were trusted when.

## Decision

1. **A pending invitation's authority is only as good as the inviter's current Membership.** Acceptance re-reads the inviter's current Membership in the same transaction that would grant the role and evaluates the grant against the inviter's current role and the invited role, with the same rule invitation sending uses: an owner may grant any role, an active admin may grant `member`, anything less refuses. An invitation whose inviter was disabled, demoted, or removed since it was issued is refused with the generic token rejection, which reveals nothing about the Organization or its members. Lawful invitations survive: a former owner who is now an active admin still admits the `member` invitations they issued, and the existing recipient, email, expiry, and single-use controls are unchanged. The refusal does not consume the token; a remaining owner may explicitly revoke the pending link.

2. **Management mutations re-read the caller's authority under the Organization row lock.** API key create, rotate, and revoke, and invitation send and revoke, lock and re-read the caller's Membership inside their transaction, exactly as rename and membership changes already do under ADR-0043. An authority change that committed before the mutation acquires its authorization locks refuses the mutation; a transaction that serialized before the authority change may finish. Role-preserving transfers are positive controls: an owner transferred to active admin retains API-key management authority, and invitation permissions are evaluated against the new role and the role being granted rather than treating every transfer as a blanket loss of authority.

3. **Invitation send re-checks Organization suspension at the same boundary.** The send transaction reads the Organization status under its lock and, when a suspension committed before that boundary, writes neither the invitation nor its email outbox request.

4. **API keys record who created and last rotated them**, joined to `user_accounts` for immutable usernames, and the key list shows that attribution, so a removed manager's keys remain visible and reviewable or revocable. The Bearer key create route requires an explicit environment instead of defaulting to Production.

5. **The identity configuration audit event records the RFC 7638 thumbprints of the public keys the configuration trusts after the change**, computed from the inline JWKS or from the key set the URL validation fetched. Swapping keys under the same issuer therefore leaves a record of which keys were trusted when; a key that cannot be thumbprinted is refused rather than trusted unrecorded.

6. **Lock order stays inversion-free.** Acceptance holds the Organization row `FOR SHARE` first, then locks the invitation row `FOR UPDATE`, keeping one consistent lock order: Organization row, then membership rows, then invitation rows when an operation touches one. Invitation send and revoke lock the Organization row `FOR UPDATE` and then the membership rows, matching disable and demotion. #854's `FOR NO KEY UPDATE` refinement applies where the locked rows' keys do not change.

## Consequences

- A removed manager's authority ends everywhere at once: pending invitations above their new authority cannot be converted by acceptance, and queued management mutations that serialize after the authority change are refused.
- Acceptance holds the Organization row shared and re-reads the inviter's Membership per redemption; refusal keeps the token unconsumed, so a remaining owner can re-invite.
- The audit trail grows attribution columns on API keys and thumbprints on identity configuration events, both durable control-plane data.
- Real-database regression tests with two connections and explicit barriers cover the refusal and the positive controls; the scripted suites cover the decision logic without a database.
