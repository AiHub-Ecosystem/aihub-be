# ADR-0164: Canonical JSON follows RFC 8785 key order

- Status: Accepted
- Date: 2026-11-13
- Related: [#329](https://github.com/AiHub-Ecosystem/aihub-be/issues/329), [ADR-0007](0007-postgres-idempotency-no-distributed-locks.md)

## Context

`canonicalJson` (`src/common/serialization/canonical-json.ts`) feeds the idempotency fingerprint, the audit and list cursors, the billing correction comparison, and the identity cache envelope. Issue #329 asked for RFC 8785 (JCS) ordering, so a client in any language that follows JCS gets the same bytes.

It sorted the keys with `Array.prototype.sort`, which compares UTF-16 code units, as RFC 8785 requires. It then rebuilt each object and called `JSON.stringify`. A JavaScript object lists integer-like keys (`"2"`, `"10"`) first, in numeric order, whatever order they were inserted in. So `{"10":..,"2":..}` came out as `{"2":..,"10":..}`, and `{"1":..,"!":..}` kept `"1"` before `"!"`. Both differ from RFC 8785. The same rebuild step also dropped a `__proto__` key; that was fixed first, under #329, with `Object.fromEntries`.

## Decision

`canonicalJson` writes the text member by member and never builds an intermediate object, so key order is exactly the UTF-16 code-unit sort. Scalars, numbers, escaping, arrays, and every error stay as they were.

## Consequences

- The bytes change only for an object with at least one integer-like key whose JS order differs from its text order. A pinned example test keeps the bytes of every other object, and the stored fingerprint digest in `idempotency-fingerprint.spec.ts` still matches.
- A request body with such keys, retried with the same `Idempotency-Key` across the deploy and inside the 24-hour retention window, gets a different fingerprint and is refused as `IDEMPOTENCY_CONFLICT` (not retryable) instead of replayed. The contracts use `additionalProperties: false`, so a body of that shape is not expected to be accepted.
- Checked after the change, by reading every caller: the pagination scope hashes use fixed names (`userId`, `organizationId`, `status`), the audit filter hash uses `actions`, `outcome`, `from` and `to`, the billing correction comparison serializes both sides with the same code, and the identity cache envelope signs API key records and `miss` markers with fixed names. None carries an integer-like key.
- The one open-ended payload is the cached JWKS entry, whose JWK members come from the provider. An integer-like member name is not expected there. If one appeared, an entry signed before the deploy would fail its MAC check and be refetched. The result is a cache miss, not corrupt data.
- A sparse array now throws as an unsupported value instead of serializing its holes as `null`. JSON parsing cannot produce one.
- Number text still comes from `JSON.stringify`, which is the ECMAScript form RFC 8785 uses.
