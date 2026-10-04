# ADR-0072: Organization API key surfaces share the read admission core

- Status: Accepted
- Related issue: #177

The four Organization API key surfaces — creation (`POST /v1/organizations/:organizationId/api-keys`), listing, rotation, and revocation — settle admission through the same core as the Organization-scoped reads introduced for #171. This extends the #171 decision, which introduced the shared core for reads only and named mutations as follow-up work, to the API key surfaces. One shared core resolves the caller's Membership and settles admission from a surface-keyed rule of `{ admittedRoles, suspensionClosesSurface, refusal }` into `{ admitted: true, caller }` or `{ admitted: false, refusal }`. The read table keeps its existing rows and refusal strings byte-for-byte; the API key table adds `api_key_create`, `api_key_list`, `api_key_rotate`, and `api_key_revoke`, each with `admittedRoles = [owner, admin]` and `suspensionClosesSurface = true`, matching where these surfaces admitted before.

Each API key surface keeps its own Safe Authorization Denial, so a refused caller learns neither the Organization's state nor which condition refused. A refusal about the request itself keeps its concrete reason: a Scope the Organization is not entitled to, the active-key limit, a key that cannot be rotated, or an unknown or empty Scope. Entitlement validation against published Scopes stays in the creation use case, before any credential is generated, and the durable repository check remains as the storage-layer backstop.

The single-use Scope authorization module is deleted; its one question is inlined at its sole call site in the API key guard. `requireOrganizationManager` remains for the invitation surface only. Rotation keeps returning the raw replacement exactly once, stores only the hash and prefix, sets `cache-control: no-store`, and never discloses retired hashes.
