# Leftover conventions recorded (username case, concurrency-permit binding)

## Username case on Membership routes

Exact matching stays. Usernames are stored in the normalized form produced by `normalizeUsername` (trimmed, lowercased), and a path parameter is matched verbatim. A differently-cased name therefore yields not-found for an authorized caller. Normalizing the parameter would require a published seam from `auth` into `identity` and would risk making a real username distinguishable from an invented one on the unauthorized path; the safe-authorization-denial contract (#176) outweighs the convenience. No behavior change.

## Concurrency-permit pairs

The controller-to-permit read (`request.aihubConcurrency` via `getConcurrencyBackgroundLifecycle`) and the idempotency-to-permit lifecycle (`{ started, settled }`) stay convention-bound. Binding them at compile time would couple the idempotency service to the gateway permit type and reduce testability of both; the route-level tests exercise the wiring. No code change.

- Status: Accepted
- Related issue: #751
