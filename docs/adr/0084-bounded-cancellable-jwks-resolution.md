# ADR-0084: Bound and cancel Organization JWKS resolution

- Status: Accepted
- Date: 2026-10-09
- Related issues: [#411](https://github.com/AiHub-Ecosystem/aihub-be/issues/411), [#402](https://github.com/AiHub-Ecosystem/aihub-be/issues/402)
- Related ADR: [ADR-0080](0080-argon2id-profile-and-memory-budget.md)

Resolve customer JWKS hostnames with Node's c-ares-backed `dns.promises.Resolver`, using DNS A/AAAA records and not `/etc/hosts` or other OS/NSS mappings. Give each in-flight JWKS operation its own Resolver so `cancel()` affects only that operation; cap DNS at 1 second with explicit query timeout/retry settings, keep the whole fetch deadline at 3 seconds, and cancel at either deadline. Preserve the existing private-address checks and address pinning. This follows Node's [DNS resolver behavior](https://nodejs.org/download/release/v22.23.3/docs/api/dns.html).

Coalesce identical JWKS work to at most one in-flight operation per Organization and allow at most eight Organizations to resolve or fetch per process. Apply these bounds to assertion verification and owner configuration validation. Do not queue work when the process cap is full: runtime verification may use an existing JWKS still inside its 24-hour stale window; a cold cache or configuration validation returns the existing retryable 503. This issue owns the minimum coalescing required for those bounds; #402 can add stale-while-revalidate and backoff on top.

Set `UV_THREADPOOL_SIZE=4` in the image before Node starts. Keep the size at four because Argon2 shares the pool and concurrent hashes have a material memory cost, as measured in ADR-0080; the resolver removes customer JWKS DNS from that shared pool. Node documents both the default pool size and that `dns.lookup()` uses it in its [CLI documentation](https://nodejs.org/download/release/v22.23.0/docs/api/cli.html).
