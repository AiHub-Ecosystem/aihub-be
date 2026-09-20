# Rotating refresh-session boundary

Status: accepted

Each successful AIHUB login creates an independent durable Refresh Session and
Refresh Token Family. Refresh rotation is strict and atomic: reuse of any
previous token revokes its entire family without a replay grace window, while
logout revokes only the current family and remains an idempotent bodyless
`204`. The #66 browser contract uses an AIHUB-hosted, host-only,
`__Host-aihub_refresh` cookie with `Path=/`, no `Domain`,
`Secure`/`HttpOnly`/`SameSite=Strict`, and a 30-day lifetime. Refresh is
cookie-only and stores one row per token version in Postgres so family lineage
and reuse state remain durable. Each successor is a fresh 32-byte CSPRNG
credential with a new 30-day sliding expiry, persisted only as a SHA-256 hash;
cookie parsing uses the Fastify cookie boundary. Login fails closed if its
session cannot be created, and refresh commits rotation before issuing the new
access JWT, so an issuer failure returns no credential and requires login again.
Refresh failures collapse to one generic `401`, with `refresh_ip` limited to 20
failures per 5 minutes and `refresh_token` limited to 5 failures per 15 minutes;
successful refreshes do not consume counters. A valid row is locked, marked
used, and replaced by a successor; reuse or revocation revokes the family, and
logout revokes a known family even from a stale token. Refresh returns the
login access-token envelope with `Cache-Control: no-store`; logout is a
bodyless `204` with a cleared cookie and the same cache directive. Expired and
revoked rows remain durable until a later bounded cleanup concern; definitive
credential failures clear the cookie, while rate-limit and infrastructure
failures preserve it. The route accepts no body or `{}` only, rejects alternate
credential sources and duplicate cookie names, uses an injectable clock with
`expires_at > now`, and keeps lifecycle mutation plus successor insertion
atomic. OpenAPI/Postman artifacts and HTTP tests remain part of the contract,
while cross-site BFF/CSRF handling is deferred until that boundary is
explicitly designed.

The durable schema is one `refresh_tokens` table with `rft_` row IDs,
`rfs_` family IDs, unique token hashes, lifecycle timestamps, user/family
indexes, and no parent session or replacement pointer. The local-auth
repository port is extended for session operations while a separate token
issuer port owns CSPRNG material and hashing. Migration `0007` runs before
code deployment and does not backfill existing accounts; OpenAPI/Postman and
the HTTP acceptance matrix are part of the slice.
