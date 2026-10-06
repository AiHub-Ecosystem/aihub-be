## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical labels documented in `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo. See `docs/agents/domain.md`.

### Role ownership

Read `.claude/agents/` for role ownership before changing a path owned by another role. Where two roles claim one path, the narrower claim wins: a `*.controller.ts` file belongs to `api` even when it sits inside another role's module, and the module role keeps everything else under it. This resolves the overlap between `api`'s `src/**/*.controller.ts` and `identity`'s `src/modules/identity/**`.

## AIHUB engineering context

### Canonical source order

Read the smallest relevant source before changing code:

1. `src/contracts/` and `src/catalog/` for executable public API behavior; `openapi.json` and `/docs` are generated from source. Use `docs/integration-guide.md` for customer integration guidance.
2. `docs/superpowers/specs/2026-09-07-aihub/01-context-and-stack.md` through `11-open-questions.md` for runtime decisions.
3. `CONTEXT.md` for the short glossary and current blockers.
4. `.claude/rules/` for path-scoped implementation constraints.

The frozen D1 design and handoff record is archived at `docs/history/aihub-deliverable-1-historical-contract.md`; use it for historical rationale, not as the active runtime contract.

If an older architecture draft conflicts with an implementation spec, record the conflict in the change summary and follow the implementation spec.

### Source boundaries

- AIHUB is one NestJS/Fastify application, not a monorepo.
- Business modules use `presentation -> application -> domain`; infrastructure implements application ports and points inward.
- `domain` has no framework, transport, environment, database, cache, or downstream imports.
- `src/common` contains only genuinely cross-cutting primitives. `src/catalog` owns operation metadata; `src/contracts` owns boundary schemas; `src/downstream` owns pure mappers and dispatch seams.
- Keep constants and configuration beside the application use case or layer that owns them; group related values by policy, and extract them only when independently reused. Avoid generic `constants` files and never move business policy into `src/common` or `domain`.
- Organization identity is explicit in `RequestContext` and application inputs. Do not recover tenant identity from a repository-global variable.
- Controllers validate and orchestrate; they do not call Postgres, Redis, or downstream HTTP clients directly.

### Runtime configuration

- The Nest application has one TypeBox-backed environment schema under `src/config`. It owns names, types, defaults, requiredness, and secret metadata; validate one snapshot before pre-DI consumers such as OpenTelemetry, then expose typed configuration through `@nestjs/config` for DI. Direct `process.env` reads stay inside the configuration boundary; this rule does not cover independent CLI and operational scripts.
- Keep Vault as the source for runtime secret values. The schema records sensitivity but never loads or prints secret values. Preserve existing `NODE_ENV` modes and `AIHUB_RUNTIME_DATABASE_SCOPE` conditions; staging follows production rules.
- Check `.env.example`, `.env.production.example`, and the CI boot fixture against the schema. The CI fixture supplies fake values; it does not define configuration metadata.
- Build one SeaweedFS S3 client per process through a shared factory in the secrets infrastructure. Nest modules receive the client through `SecretsModule`'s public seam; the independent CLI composition root calls the factory with explicit configuration and Vault values. Adapters select their bucket; deployment configuration maps tier-specific bucket values to canonical application variable names.

### Security and reliability

- Never log API keys, signed user assertions, internal JWTs, essay text, raw request bodies, or raw downstream responses.
- API-key hashes, identity configuration, usage, and idempotency records are durable control-plane data; Redis is only cache/counter/protection state.
- Downstream adapters are pure. Dispatcher/HTTP infrastructure owns hosts, timeouts, cancellation, internal tokens, and error translation.
- Never invent a downstream response shape. Map only from a captured fixture; if none exists, stop at the contract boundary and surface the blocker rather than guessing. The Writing grading contract is resolved and its fixtures live in `test/fixtures/ai-writing/`, so this rule now applies to the next service, not to Writing. `test/provider-contract-drift.spec.ts` compares the Speaking schema with the contract the provider publishes (`docs/contracts/ai-services/ai-speaking-grading-v1.md`, section 9).

### Deployed state

To check what is live on the production host (commit, health, errors since start), run `ops/status.sh` as `docs/operations/deploy-vps.md` describes under "Checking deployed state".

### Required verification

Use the narrowest check while iterating, then run the full loop before handoff:

```text
pnpm test -- focused-file.spec.ts
pnpm type-check
pnpm arch-check
pnpm verify
```

`pnpm build` is a pure SWC transform; type ownership lives in `type-check` (via `pnpm verify`).

`pnpm verify:summary` runs the same loop and prints only the result, the first failing step, and the path of a log file of its own; use it when the output is read into context.

Read `.claude/agents/` for role ownership before changing a path owned by another role. Keep `CLAUDE.md` Claude-specific; shared rules belong here and in `.claude/`.
