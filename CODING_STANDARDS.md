# Coding Standards

This file records review criteria that need engineering judgment. Deterministic
rules belong in automated checks; see `bun run check:changed` and `bun run verify`
rather than copying their rules here.

## Review criteria

- **Respect ownership and seams.** Keep policy with the module and layer that
  owns it. Depend on published interfaces instead of reaching into another
  module's implementation.
- **Preserve behavior deliberately.** Keep existing contracts, error meanings,
  tenant boundaries, and data guarantees unless the issue explicitly changes
  them. Do not infer an external contract without evidence.
- **Prefer cohesive, minimal designs.** Put behavior where its data and
  decisions belong. Add an abstraction when it removes real duplication or
  hides complexity; avoid wrappers and options that only pass work through.
- **Test observable behavior.** Prefer assertions about outcomes and boundaries
  over private implementation details, except where an accepted ADR records an
  ordering as public behavior.

Use [AGENTS.md](AGENTS.md), the matching files under `.claude/rules/`, and the
accepted [ADRs](docs/adr/) for the detailed rules that apply to a change. An
accepted ADR takes precedence over this summary.
