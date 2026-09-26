# ADR-0055: Owner-only read of the Organization Identity Configuration

- Status: Accepted
- Related issue: #171
- Related ADR: ADR-0049, ADR-0028, ADR-0040

Reading the Organization Identity Configuration through the Bearer boundary is owner-only, exactly as ADR-0049 makes writing it owner-only. An active `admin` is refused. Every other Organization-scoped read admits owners and admins together, so this surface is the single exception on the read side.

The configuration is what decides who the Organization vouches for: its issuer and JWKS determine which Signed User Assertions are accepted, and therefore which End-User IDs reach the Organization's downstream AI Services. It grants standing rather than describing settings, so it is read under the authority of the Membership Role that can change an Organization's identity, not the one that manages membership and API keys.

The alternative was to admit admins on the read, leaving the read wider than the write. That was rejected because it would let an admin see the Organization's assertion trust anchor while being unable to change it, which is neither a useful intermediate step nor a meaningful limit. The alternative was to make the read follow whatever ADR-0049 later changes to; that was rejected because the write policy and the read policy answer different questions, and coupling them would make a future write-policy change silently alter who can read.

The refusal is the existing Safe Authorization Denial, so a member, a disabled member, a non-member, an admin, and a caller in a suspended Organization all receive the same response and learn nothing about the Organization's state. This is an Organization-scoped surface that closes on suspension, unlike the Organization Audit Read in ADR-0040.

This ADR covers the read half only. ADR-0049's create-and-replace half is unchanged.
