# Organization invitation revocation boundary

Status: accepted

Revoking an Organization Invitation is an organization-scoped control action at `DELETE /v1/organizations/{organization_id}/invitations/{invitation_id}`. Owners may revoke invitations for any Membership Role; admins may revoke only invitations granting `member`; every other caller receives the existing safe policy denial, while unknown or foreign invitations resolve as `NOT_FOUND`. The operation uses the existing invitation close signal (`consumed_at`) in one transaction, returns bodyless `204` for both an applied close and a retry-safe already-closed or expired target, and never introduces a public revoked status or a second close mechanism.

The repository locks the Organization before the invitation row so revocation serializes with organization invitation mutations. Only an unconsumed, unexpired invitation is changed; accept, resend, and revoke therefore converge on one durable row, with a concurrent loser observing the closed state. Acceptance continues to collapse revoked, consumed, superseded, and expired tokens into its generic invalid-token result.

The applied transition records `invitation.revoked` in the same durable act, with only the invitation id, normalized email, and role; a repeat, expired target, or other no-op records nothing. An active member denied against a real invitation may produce a best-effort denial event outside the mutation transaction, while non-members, disabled callers, suspended Organizations, and unknown or cross-Organization targets produce no audit write. No token, token hash, or idempotency record is added by this boundary; general invitation idempotency remains a separate follow-up.
