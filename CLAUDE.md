# AIHUB — Claude Code Project Instructions

@AGENTS.md

## Canonical project context

- AIHUB is a B2B multi-tenant AI API Gateway in front of private AI services.
- The repository is currently documentation-first; read the relevant spec before implementing code.
- Start with `docs/superpowers/specs/2026-09-07-aihub/README.md` and follow its linked spec files.
- The root `AIHUB_*.md` files are architecture and contract sources; do not duplicate them here.
- When the implementation spec and an older architecture draft differ, call out the conflict and use the current implementation spec.

## Working rules

- Keep `AGENTS.md` as the shared agent-workflow source of truth.
- Keep this file concise; add only Claude-specific guidance here.
- Do not create `CONTEXT.md` or ADRs by copying the existing specs; add them only when a new domain decision needs a concise record.
