## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical labels documented in `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo. See `docs/agents/domain.md`.

## AIHUB engineering context

### Canonical source order

Read the smallest relevant source before changing code:

1. `docs/aihub_deliverable_1_api_contract_schema.md` for public API behavior.
2. `docs/superpowers/specs/2026-09-07-aihub/01-context-and-stack.md` through `11-open-questions.md` for runtime decisions.
3. `CONTEXT.md` for the short glossary and current blockers.
4. `.claude/rules/` for path-scoped implementation constraints.

If an older architecture draft conflicts with an implementation spec, record the conflict in the change summary and follow the implementation spec.

### Source boundaries

- AIHUB is one NestJS/Fastify application, not a monorepo.
- Business modules use `presentation -> application -> domain`; infrastructure implements application ports and points inward.
- `domain` has no framework, transport, environment, database, cache, or downstream imports.
- `src/common` contains only genuinely cross-cutting primitives. `src/catalog` owns operation metadata; `src/contracts` owns boundary schemas; `src/downstream` owns pure mappers and dispatch seams.
- Organization identity is explicit in `RequestContext` and application inputs. Do not recover tenant identity from a repository-global variable.
- Controllers validate and orchestrate; they do not call Postgres, Redis, or downstream HTTP clients directly.

### Security and reliability

- Never log API keys, signed user assertions, internal JWTs, essay text, raw request bodies, or raw downstream responses.
- API-key hashes, identity configuration, usage, and idempotency records are durable control-plane data; Redis is only cache/counter/protection state.
- Downstream adapters are pure. Dispatcher/HTTP infrastructure owns hosts, timeouts, cancellation, internal tokens, and error translation.
- Never invent a downstream response shape. Map only from a captured fixture; if none exists, stop at the contract boundary and surface the blocker rather than guessing. The Writing grading contract is resolved and its fixtures live in `test/fixtures/ai-writing/`, so this rule now applies to the next service, not to Writing.

### Required verification

Use the narrowest check while iterating, then run the full loop before handoff:

```text
pnpm test -- focused-file.spec.ts
pnpm type-check
pnpm arch-check
pnpm verify
```

`pnpm build` is a pure SWC transform; type ownership lives in `type-check` (via `pnpm verify`).

Read `.claude/agents/` for role ownership before changing a path owned by another role. Keep `CLAUDE.md` Claude-specific; shared rules belong here and in `.claude/`.
