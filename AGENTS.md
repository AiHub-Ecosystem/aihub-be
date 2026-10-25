## Agent skills

### Issue tracker

Before filing or editing an issue, read `docs/agents/issue-tracker.md`: every open issue carries a milestone, one triage role, and a priority, and `node scripts/checks/check-issue-triage.mjs` must pass. Issues and specs live in GitHub Issues; use the `gh` CLI.

### GitHub language

All content pushed to GitHub — commit messages, issue/PR titles and bodies, comments, reviews — must be written in English. Local chat may stay in the user's language.

### Commit messages

Every commit header is Conventional Commits: `type(scope): subject`, where type is one of `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`. The scope is optional and lowercase; a breaking change adds `!` before the colon; the header is at most 100 characters. `.husky/commit-msg` enforces the header, and merge, revert, and `fixup!`/`squash!` commits are exempt.

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
3. `docs/adr/` for the accepted decisions touching the area you are changing. An accepted ADR outranks a spec or draft that predates it; read the record's `Status:` and `Amends:` lines before treating one as current, and record a conflict rather than silently overriding it.
4. `CONTEXT.md` for the short glossary and current blockers.
5. `.claude/rules/` for path-scoped implementation constraints.

The frozen D1 design and handoff record is archived at `docs/history/aihub-deliverable-1-historical-contract.md`; use it for historical rationale, not as the active runtime contract.

If an older architecture draft conflicts with an implementation spec, record the conflict in the change summary and follow the implementation spec — unless an accepted ADR says otherwise, in which case follow the ADR.

### Source boundaries

- AIHUB is one NestJS/Fastify application, not a monorepo.
- Business modules use `presentation -> application -> domain`; infrastructure implements application ports and points inward.
- Identity code is grouped by feature at `src/modules/identity/<feature>/<layer>/`: use cases, ports, policies, and their specs go in `application/`; controllers, guards, decorators, and route specs in `presentation/`; repositories, adapters, and adapter specs in `infrastructure/`. Keep cross-cutting Identity code under `identity/shared/<layer>/` and each feature-layer folder at 20 direct entries or fewer; split a crowded feature before it exceeds that ceiling.
- Hand-written source files are capped at 500 code lines (ADR-0110); composition roots, single-schema configuration, and catalogues are exempt with stated reasons. The existing oversized files are grandfathered behind an allowlist and carry a `ponytail:` header comment until refactored.
- Keep scripts under `scripts/{cli,ops,generate,checks,ci,runtime}/` by purpose. Group CLI specs under `test/cli/` and integration specs under `test/integration/`; shared setup and cross-cutting specs may stay at `test/` root. Keep each root at 15 direct entries or fewer.
- Cross-module TypeScript APIs live under the owning module's `public/` facades unless they use an established seam: application ports, shared Fastify request primitives, Nest decorators, module composition roots, or Nest-exported providers. Consumers use the matching seam instead of other implementation paths.
- A controller validates a request body with `parseRequestBody` from `src/common/http`, never `Value.Check` or `Value.Parse` directly. The schema's `default` values apply because that helper parses, and checking before parsing is what rejects a body whose field has the wrong type. `pnpm arch-check` enforces it; a call that is not body validation keeps only by marking its own line with `arch-check: <reason>`.
- `domain` has no framework, transport, environment, database, cache, or downstream imports.
- `src/common` contains only genuinely cross-cutting primitives. `src/catalog` owns operation metadata; `src/contracts` owns boundary schemas; `src/downstream` owns pure mappers and dispatch seams.
- Keep constants and configuration beside the application use case or layer that owns them; group related values by policy, and extract them only when independently reused. Avoid generic `constants` files and never move business policy into `src/common` or `domain`.
- Organization identity is explicit in `RequestContext` and application inputs. Do not recover tenant identity from a repository-global variable.
- Controllers validate and orchestrate; they do not call Postgres, Redis, or downstream HTTP clients directly.

### Working files

When a task generates throwaway files that must not be committed — issue-body scratch, captured diffs, log dumps, one-shot helper scripts — write them under `temp/` at the repository root, not beside source, not under `src/`, `scripts/`, `test/`, or `docs/`, and not in a shell home or an out-of-repo cache. Create `temp/` on demand; the folder is not committed and carries no sentinel. Delete every file you wrote there, and remove `temp/` itself if it becomes empty, before reporting the task complete. `temp/` is gitignored and never an input to build, test, or deploy.

### Runtime configuration

Before changing `src/config`, an environment file, a Vault-held secret, or the SeaweedFS client, read `docs/agents/runtime-configuration.md`.

### Security and reliability

- Never log API keys, signed user assertions, internal JWTs, essay text, raw request bodies, or raw downstream responses.
- API-key hashes, identity configuration, usage, and idempotency records are durable control-plane data; Redis is only cache/counter/protection state.
- Downstream adapters are pure. Dispatcher/HTTP infrastructure owns hosts, timeouts, cancellation, internal tokens, and error translation.
- Never invent a downstream response shape. Map only from a captured fixture; if none exists, stop at the contract boundary and surface the blocker rather than guessing. The Writing grading contract is resolved and its fixtures live in `test/fixtures/ai-writing/`, so this rule now applies to the next service, not to Writing. `test/provider-contract-drift.spec.ts` compares the Speaking schema with the contract the provider publishes (`docs/contracts/ai-services/ai-speaking-grading-v1.md`, section 9).

### Deployed state

Before checking what is live in production, changing nginx, or assessing host access, read `docs/agents/production-host.md`.

Treat implementation and release as separate authorizations. VPS credentials do not authorize pushing, enabling deployment gates, or triggering production deployment; do those only when the user explicitly requests them.

### Review

A reviewer reads `AGENTS.md`, the `.claude/rules/` files whose `paths` match the diff, and the ADRs the diff touches. The mechanical gates have run by then, so review judgement calls the checks cannot make.

### Required verification

After each batch of edits run `pnpm check:changed`: it reads the changed files from git and runs the gates they can break (`oxlint` and `biome`, import style, file size, `arch-check`, `type-check`, the related specs, and `prettier` for docs). Run `pnpm verify` once, at the end, before handoff. `pnpm test -- focused-file.spec.ts` runs one spec.

`pnpm build` is a pure SWC transform; type ownership lives in `type-check` (via `pnpm verify`).

`pnpm verify:summary` runs the same loop and prints only the result, the first failing step, and the path of a log file of its own; use it when the output is read into context.

Before starting a full loop, and whenever a run dies with a worker or heap error, read `docs/agents/verification.md` for the memory budget. Low free RAM alone is not a reason to defer verification or ask for confirmation: run the loop with Jest's automatic worker cap (one worker below 4 GiB free, two otherwise, unless explicitly overridden).

A worker or heap death is not a test result. Read the error line, then re-run the named suite alone: a suite that passes alone did not fail, and the rest of that run is not evidence about the change. Do not reach green by skipping a suite, lowering a `coverageThreshold`, or editing an assertion — record what was observed and why the run is inconclusive.
