# Organization roster read boundary

Status: accepted

The Bearer-authenticated self-roster is a read-only view of the Organizations to which the caller has an active membership. Owners, admins, and members may read it; disabled memberships are excluded, suspended Organizations remain visible read-only, and a valid account with no active memberships receives an empty result. The response groups Organizations and exposes organization identity, configured entitlement names, an `identity_configured` readiness boolean, plus member usernames and roles—never email addresses, auth identities, tokens, commercial limits, User Account IDs, issuers, or JWKS material—using the existing `{ data, meta: { request_id } }` envelope.

`identity_configured` is true only when an active Organization Identity Configuration exists; it reports saved state and does not probe JWKS reachability. The value applies to every roster caller and remains independent of Organization suspension. A failure to read or project readiness fails the whole roster instead of returning false or a partial result.

The durable membership link uses the natural `(organization_id, user_account_id)` key with role/status checks and restrictive foreign keys. Authorization resolves that link at request time with no indefinite cache; absent or disabled membership is `FORBIDDEN`, while lookup/projection failure is a safe `INTERNAL_ERROR`. Internal denial reasons remain typed but are not distinguished publicly. The initial roster is deliberately unpaginated with deterministic ordering and one database snapshot; pagination is a follow-up if roster size requires it. Invalid projections fail the whole request rather than producing partial data, and username is the immutable public member identifier for this MVP.

The authorization projection includes Organization lifecycle status so later mutation use cases can reject suspended Organizations, while the read-only roster may still show them. This slice does not add database triggers for the zero-owner invariant or disable audit metadata; operator provisioning and the later membership-management/audit slices own those concerns.
