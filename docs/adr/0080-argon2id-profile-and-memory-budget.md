# ADR-0080: Gate the Argon2id profile on measured memory headroom

- Status: Accepted
- Date: 2026-10-07
- Related: [#274](https://github.com/AiHub-Ecosystem/aihub-be/issues/274), [#268](https://github.com/AiHub-Ecosystem/aihub-be/issues/268), [#269](https://github.com/AiHub-Ecosystem/aihub-be/issues/269), [#270](https://github.com/AiHub-Ecosystem/aihub-be/issues/270), [ADR-0022](0022-aihub-local-user-authentication.md)

The current Password hashing profile is Argon2id `m=65536 KiB, t=3, p=1`. Four concurrent operations can reserve about 256 MiB for Argon2 work in the default four-worker libuv pool. The decision is whether that leaves sufficient whole-process headroom inside the 768 MiB container.

## Decision

- Measure four concurrent password hash/verify operations in an isolated app container with a 768 MiB memory limit. Exclude Speaking uploads; #270 owns their in-flight ceiling and RSS measurements.
- Keep the current profile if peak process RSS is at most 614 MiB, preserving 20% of the container limit as headroom.
- If peak RSS exceeds 614 MiB, use Argon2id `m=19456 KiB, t=2, p=1` for new hashes. Keep existing encoded hashes verifiable and upgrade an old hash after successful login. Persist the upgrade only if the stored hash still matches the one just verified, so a concurrent password reset is not overwritten.
- Measure peak RSS again with the same workload after the decision. Record `dns.lookup` p95 while idle and during the hash burst, including the delta. There is no DNS latency SLO, so the delta is evidence rather than a pass/fail gate.
- Do not increase `UV_THREADPOOL_SIZE` as part of this decision; additional workers can increase simultaneous Argon2 memory use.

## Measurements (2026-10-07)

Two runs used the repository's pinned runtime image with the Nest/Fastify server listening in an isolated container limited to 768 MiB memory, no swap, and 1.5 CPUs. `UV_THREADPOOL_SIZE=4`. Each run completed four rounds of four concurrent operations: two hashes and two verifies. Speaking uploads and external service traffic were excluded; database and Redis URLs pointed to unused loopback ports, and runtime credentials were generated test values. RSS was sampled every 5 ms. DNS p95 used 100 sequential `dns.lookup('localhost')` calls while idle and lookups scheduled every 20 ms during the hash burst; this captures libuv queueing against the local hosts entry, not end-to-end external DNS resolution.

| Run                        | Post-warmup RSS |  Peak RSS | Headroom to 768 MiB | DNS p95 idle | DNS p95 during burst |       Delta |
| -------------------------- | --------------: | --------: | ------------------: | -----------: | -------------------: | ----------: |
| Before decision            |       136.5 MiB | 393.3 MiB |           374.7 MiB |     0.188 ms |           403.579 ms | +403.391 ms |
| Confirmation, same profile |       136.9 MiB | 393.4 MiB |           374.6 MiB |     0.149 ms |           399.953 ms | +399.804 ms |

Both peaks are more than 220 MiB below the 614 MiB gate, so keep the current profile. The DNS p95 increase is recorded as evidence; no DNS SLO was set, so it does not trigger a profile change.

OWASP lists `m=19456 KiB, t=2, p=1` as a minimum recommended Argon2id profile. [Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

If the lower profile still exceeds the RSS threshold, record that result and revisit the wider container budget under #268; do not keep lowering password-hash cost in this issue. The confirmation run repeated the current profile after the decision; no profile migration or login rehash is needed while the RSS gate passes.
