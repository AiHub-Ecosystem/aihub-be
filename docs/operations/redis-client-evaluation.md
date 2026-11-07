# Redis client evaluation: ioredis vs node-redis

Status: evaluation completed for
[#1698](https://github.com/AiHub-Ecosystem/aihub-be/issues/1698). No
migration is authorized by this document.

## Decision

**Defer migration under named triggers.** Stay on ioredis 6 until one of
these triggers fires:

- T1 - ioredis stops merging relevant fixes or a needed bug/security fix
  never lands upstream.
- T2 - a named Redis 8 capability is adopted for a real seam (for example,
  Streams in #1415 or hash-field expiration for the JWKS cache).
- T3 - #1302 adopts cached scripts (EVALSHA/defineScript) and the
  measurement favors the node-redis shape.
- T4 - @opentelemetry/instrumentation-ioredis stops releasing or drops
  support for the ioredis version AIHUB pins.

Revisit this document when a trigger fires. Do not migrate speculatively:
the migration risk lands on graded, fail-closed admission paths
(ADR-0116) while the only active pressure is the deprecation banner, and
ioredis 6 remains stable with best-effort maintenance that still merges
relevant contributions.

## Why ioredis is deprecated, and why that is not yet urgent

The npm package page for ioredis says the project is stable and
maintenance is done on a best-effort basis, and recommends node-redis for
new projects. node-redis is the Redis-maintained client and the first to
expose Redis 8 features (hash-field expiration, JSON, search, time-series,
probabilistic structures, vector sets).

That is a direction, not an incident. AIHUB pins `ioredis ^6.0.0` with no
cluster/sentinel usage, no Pub/Sub, and 17 static Lua scripts issued with
plain `EVAL`. Nothing in the current seam needs an unshipped fix, and the
OTel instrumentation for ioredis released a version on 2026-11-05, one
day before this evaluation, so T4 is not close.

## Seam consumers

Every consumer of the shared client seam:

- `src/common/redis/create-redis-client.ts` (factory): commandTimeout,
  maxRetriesPerRequest 1, enableOfflineQueue false, optional
  connectTimeout, optional autoResendUnfulfilledCommands, swallowed error
  event, returns a raw ioredis client.
- Gateway `src/modules/gateway/infrastructure/redis-gateway.client.ts`
  (RedisGatewayClient): ping, get, set EX, incr, expire, eval,
  evalNumbers, zrem, quit with disconnect fallback. Consumers:
  concurrency limiter, graded admission, quota counter/seed/reconciliation,
  rate limiter, downstream retry budget.
- Identity `src/modules/identity/shared/infrastructure/redis-identity.store.ts`
  (RedisIdentityClient): get, pttl, set EX [NX], del, incr, eval, expire,
  quit. Consumers: API-key cache, JWKS cache, auth-failure counter via
  incrementRedisCounterWithExpiry.
- Auth rate limiter
  `src/modules/auth/rate-limit/infrastructure/redis-auth-rate-limiter.ts`:
  hand-built `new Redis` with `lazyConnect: true`; narrow AuthRedisClient
  (eval, on, disconnect). Two EVAL scripts.
- Email send-rate limiter `redis-email-send-rate-limiter.ts`: hand-built
  `new Redis` with `lazyConnect: true`; narrow
  EmailSendRateRedisClient. Six EVAL scripts.
- Operator CLI `src/cli/cli-redis.ts` (connectCliRedis): lazyConnect true,
  5 s timeouts, raw return type. Consumers: purgeApiKeyCache (del),
  redis-ttl-audit (scan + pipeline ttl), quota-reconcile (get/set).
- N-1 CI `scripts/ci/n-minus-one/`: direct `new Redis`, two probes use
  `require('ioredis')` inside container scripts. JWKS cache, API-key
  cache, endpoint identity (redis-endpoint-compatibility.ts).
- Test DB lane `test/db/shared/database.ts`: direct `new Redis`,
  createSandboxTestRedis (loopback DB 14).
- OTel `src/common/observability/open-telemetry.ts`: IORedisInstrumentation
  with dbStatementSerializer redisOperationName, requireParentSpan true.

The request-path surface is aihub_redis_unavailable_total with 13 seam
labels; its meaning is producer-defined in
`src/common/observability/redis-unavailable-metric.ts` and must not
change with the client.

## API differences that touch this seam

Source: Redis official migration guide at redis.io/docs/latest/develop/clients/nodejs/migration/.

- **Connection lifecycle.** ioredis connects on construction (or with
  `lazyConnect: true`, on first commands or connect()). node-redis
  requires an explicit `connect()` call; issuing a command before it
  rejects. The two hand-built limiters and the CLI use `lazyConnect`, so
  an adapter must reproduce lazy startup behind the factory or force a
  connect at module init. node-redis also emits a `reconnecting` event
  that ioredis does not, which is directionally what #1459 wants for
  churn observability, but #1459 is client-agnostic and can land first.
- **SET argument shape.** AIHUB calls set(key, value, 'EX', seconds) and
  set(key, value, 'EX', seconds, 'NX'). node-redis takes an options
  object: set(key, value, { EX: seconds }),
  set(key, value, { EX: seconds, NX: true }). This touches the identity
  store, gateway client, and CLI quota path; string values are otherwise
  identical.
- **EVAL argument shape.** Largest change. ioredis:
  eval(script, numKeys, ...args). node-redis:
  eval(script, { keys: [...], arguments: [...] }). All 17 production Lua
  scripts move unchanged (server-side behavior is identical), but every
  call site and every RedisScriptEvaluator adapter changes, including
  the numberReply / integerArrayReply narrowing of replies.
- **Command timeout and retries.** ioredis commandTimeout,
  maxRetriesPerRequest 1, enableOfflineQueue false, and
  autoResendUnfulfilledCommands false are first-class options. In
  node-redis they map to socket.commandTimeout, a reconnectStrategy
  function, and offline behavior with no per-request retry count; exact
  equivalence (especially one retry per request and never replaying a
  mutating EVAL after reconnect) must be proven in a spike, not assumed.
  The 400 ms margin in redis-round-trip.md is re-measured after any swap.
- **quit/disconnect.** AIHUB adapters call quit() and fall back to
  disconnect() because a failed quit otherwise leaves ioredis
  reconnecting and keeps a shutting-down process alive. node-redis
  exposes quit() and destroy() with the same shutdown-hang risk in
  different clothing; the fallback pattern must be re-implemented and
  its specs updated.
- **Pipeline reply shape (CLI only).** redis-ttl-audit uses
  pipeline().ttl() + exec() returning [error, result] tuples. node-redis
  multi().execAsPipeline() returns a results array with a different
  error shape, so the audit's per-key error handling must be rewritten,
  not just re-called.
- **SCAN (CLI only).** scan(cursor, 'MATCH', ..., 'COUNT', n) returns
  [cursor, keys] in ioredis; node-redis returns the cursor and offers
  scanIterator() pages. Small and mechanical, confined to the TTL audit.
- **Cluster/sentinel.** AIHUB does not use either: one Redis host per
  environment, logical databases /0 (primary), /1 (sandbox), /2 (email
  rate), /14 (sandbox test). Both clients accept the same URL form, so
  the sandbox /1 setup needs no change. The N-1 gate compares full
  endpoint identity including the DB index (redisCutoverDecision); a
  client swap that keeps URLs identical should not trip it, and any URL
  change would. No Pub/Sub is used.

## OTel instrumentation

This is not a blocker today. @opentelemetry/instrumentation-ioredis 0.73.0
was published 2026-11-05 and supports ioredis >=2.0.0 <7, so the pinned
client stays instrumented. The node-redis counterpart,
@opentelemetry/instrumentation-redis 0.73.0 (published the same day),
supports redis >=2.6.0 <7 and exposes the same options AIHUB uses
(dbStatementSerializer, requireParentSpan), and both emit the stable
semantic conventions with db.operation.name derived from the command
name. AIHUB sets requireParentSpan true explicitly in both cases, so no
behavior change is expected. A swap would replace one dependency for the
other and re-verify redisOperationName output in
span-sanitizers.spec.ts (for example evalsha to EVALSHA); the span
attribute contract does not change.

## Redis 8 capabilities

None of the Redis 8 additions are needed by the current seam. The
protection/cache state is strings, sorted-set leases, hashes, and Lua
scripts, all of which work identically on both clients. Streams with
consumer groups and XAUTOCLAIM (#1415) is available through both clients,
so the client choice does not gate that evaluation. Hash-field expiration
is the only item that could change a current design (the JWKS cache's
generation-key plus entry-key pair), and no issue has proposed adopting
it. Redis 8 is not a migration driver today; it becomes one only through T2.

## Migration risk surface

- **Fail-closed graded paths.** Graded admission, concurrency, quota, and
  retry-budget decisions are verified Redis decisions that refuse with
  503 REDIS_UNAVAILABLE on error or ambiguity (ADR-0116, amended
  ADR-0006). A client-level behavioral difference (retry counts, replay of
  unfulfilled commands, offline queueing) can turn into customer-facing
  503s or silent double-mutation. The #1345 record shows the replay risk
  is already understood for ioredis; the same proof is needed again for
  node-redis.
- **Timeout margins.** The 400 ms command timeouts were calibrated against
  a measured ~108 ms round trip; a new client needs a fresh measurement
  before its acceptability is known.
- **Two hand-built clients outside the factory.** The auth and email
  limiters construct Redis directly, so a factory-only swap leaves them
  behind. #1345 (route all request-path clients through
  createRedisClient) is a prerequisite for a clean migration and should
  land first.
- **N-1 gate fixtures.** The probes run require('ioredis') inside
  containers and construct `new Redis` at step 0; swapping the client
  without swapping the probes makes the compatibility gate test a fixture
  the candidate never had.
- **Runtime benchmark snippet.** redis-round-trip.md embeds a measurement
  snippet that imports ioredis; it must be updated or the next operator
  runs the wrong client.

## Staged order if migrating

1. **Spike first (no production code).** Wrap node-redis behind the
   existing createRedisClient signature in temp/, prove command timeout,
   reconnect behavior, and shutdown (quit/destroy), and record which
   ioredis options have no exact node-redis equivalent.
2. **Adapter behind the seam.** Swap the runtime inside the factory and
   the narrow port adapters (RedisGatewayClient, RedisIdentityClient,
   AuthRedisClient, EmailSendRateRedisClient); no consumer logic changes.
   Bring the two hand-built limiters through the factory per #1345 as
   part of this step.
3. **OTel swap.** Replace instrumentation-ioredis with
   instrumentation-redis and re-verify span attributes.
4. **CLI, probes, test lane.** connectCliRedis, TTL audit, quota
   reconcile, N-1 probes, and createSandboxTestRedis.
5. **Remove the old dependencies.** Drop ioredis and
   instrumentation-ioredis from package.json, update redis-round-trip.md,
   and re-measure the round trip before asserting the 400 ms margin
   still holds.

## Specs that must not change

These assert customer-visible behavior, so a migration must pass them
unchanged (only driver-shaped assertions such as client options may be
adapted):

- `src/common/redis/create-redis-client.spec.ts` (timeouts, offline
  queue, silent error listener).
- `src/modules/gateway/infrastructure/redis-gateway.client.spec.ts`
  (400 ms margins over the measured round trip).
- Gateway seam specs on RedisGatewayClient: redis-graded-admission,
  redis-concurrency-limiter, redis-quota-counter, redis-quota-seed,
  redis-downstream-retry-budget, redis-rate-limiter,
  redis-quota-reconciliation.counter.
- Identity store, JWKS, API-key cache, and auth-failure counter specs
  (including increment-with-expiry and number-reply).
- Auth rate limiter and email send-rate limiter specs (fallback and
  script constants).
- `src/common/observability/span-sanitizers.spec.ts` (command-name
  normalization contract for spans).
- `docs/operations/redis-round-trip.md` margin rule and the seam meaning
  of aihub_redis_unavailable_total.
- The 17 Lua script sources themselves.

## References

- [Redis migration guide](https://redis.io/docs/latest/develop/clients/nodejs/migration/)
- [ioredis deprecation notice](https://www.npmjs.com/package/ioredis)
- [@opentelemetry/instrumentation-ioredis](https://www.npmjs.com/package/@opentelemetry/instrumentation-ioredis) and [@opentelemetry/instrumentation-redis](https://www.npmjs.com/package/@opentelemetry/instrumentation-redis)
- [Client comparison (2026)](https://www.runxbuild.com/blog/ioredis/)
- Related issues: #1302 (EVAL overhead), #1345 (shared seam), #1415
  (Streams), #1459 (connection churn observability)
