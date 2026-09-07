# Skill: Domain boundary check

Use before approving a domain or application change.

- Domain contains only invariants and domain-safe values.
- Application exposes ports and explicit organization context.
- No raw headers, environment reads, concrete SDKs, or persistence models cross inward.
- Expected errors use the shared error taxonomy.
- `pnpm arch-check` and the focused tests pass.
