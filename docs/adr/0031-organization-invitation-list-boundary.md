# Organization invitation listing boundary

Status: accepted

The open-invitation view is a Bearer-authenticated, organization-scoped read available only to active owners and admins; a suspended Organization is denied even though its read-only roster remains visible. The shared response contains unpaginated invitation metadata—normalized invited email, role, immutable issuer username, creation time, expiry, and `pending` status—in deterministic newest-first order, excludes consumed, superseded, revoked, and expired records, and never exposes account IDs or invite proofs. Expired invitation rows remain durable for later lifecycle actions; listing does not add cleanup, revocation, pagination, filtering, or a second invitation source of truth.
