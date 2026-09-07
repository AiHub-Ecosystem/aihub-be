# AIHUB — Claude Code Project Instructions

@AGENTS.md

## Canonical project context

- AIHUB is a B2B multi-tenant AI API Gateway in front of private AI services.
- Read `CONTEXT.md` for the short glossary, then the relevant canonical spec before implementing code.
- Start with `docs/superpowers/specs/2026-09-07-aihub/README.md` and follow its linked spec files.
- The root `AIHUB_*.md` files are architecture and contract sources; do not duplicate them here.
- When the implementation spec and an older architecture draft differ, call out the conflict and use the current implementation spec.

## Working rules

- Keep `AGENTS.md` as the shared agent-workflow source of truth.
- Keep this file concise; add only Claude-specific guidance here.
- Apply path-scoped rules from `.claude/rules/` and role ownership from `.claude/agents/` before editing source.
- Do not copy the existing specs into `CONTEXT.md` or ADRs; keep those files as short indexes or records of new decisions.
- Run `pnpm verify` before claiming a scaffold or feature is complete.
