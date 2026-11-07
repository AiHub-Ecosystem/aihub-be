# ADR-0003: API keys use SHA-256 hashes, not bcrypt/argon2

- Status: Accepted (retroactive record)
- Date: decided 2026-09-07 in the implementation specification suite; file written 2026-11-07

## Context

People routinely apply password hashing to API keys. The two credentials differ
in kind: a password has low entropy and must resist offline guessing; an API
key is CSPRNG output with zero dictionary to attack.

## Decision

API keys are 32 bytes (256 bits) of CSPRNG randomness and are persisted only as
`sha256(raw_key)`. bcrypt/argon2 is deliberately not used.

- A slow hash adds zero security against a random 256-bit key — there is no
  dictionary to slow down. In exchange it burns ~100 ms of CPU per request;
  at the Stage A load profile that is a self-inflicted denial of service.
  Stripe and GitHub use fast cryptographic hashing for the same reason.
- `key_hash` is UNIQUE, so lookup is a single index seek — no
  "find by prefix, compare candidates" pattern, and no constant-time comparison
  is needed because the lookup is by hash, not a verification across candidates.
- `key_prefix` exists purely for dashboard display.

Local user-account passwords do use Argon2id with a recorded work profile;
that is a separate boundary with a separate rationale (see CONTEXT.md,
Password hashing profile).

## Consequences

- Key verification is O(1) and cheap; hashing happens in the Identity API-key
  generator and boundary code (`organization-api-key-generator.ts`).
- Compromising `key_hash` values alone does not leak usable keys, but SHA-256
  provides no stretch: it is safe only because the input is 256-bit random.
  If key generation ever weakened, this decision must be revisited.
