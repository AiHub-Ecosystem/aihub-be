# Source file length and class responsibility ceiling

Hand-written source files are capped at **500 code lines** (blank lines and comments excluded), measured by oxlint `max-lines` with `skipBlankLines` and `skipComments`. A file that exceeds the ceiling cannot be added or grown; the 12 existing oversized files are grandfathered behind an oxlint `overrides` entry, each carrying a `ponytail:` header comment naming why it is above the ceiling and its follow-on split ticket. Entries are removed from the allowlist as refactors land.

Function level: a complexity ceiling starting at the current maximum (64, `loadRuntimeConfiguration`) is enforced by `eslint/complexity` with a shrinking allowlist; nesting depth is capped at 4 (`max-depth`); an infrastructure function above complexity 10 is a review finding. Function length follows from complexity.

Exemptions (with stated reasons): composition roots (`identity.module.ts`), single-schema configuration (`runtime-configuration.ts`, ADR-0075), catalogues (`public-routes.ts`, `OPERATION_CATALOG`). OpenAPI/Postman builders are **not** exempt and are tracked under #421.

A floor is named as a sibling rule: a module file holding a single symbol with one consumer should be folded into that consumer, with exemptions for `public/index.ts` facades (ADR-0067) and small ports (ADR-0073). Enforcement of the floor is deferred.

Cross-links: ADR-0082 (folder-entry ceiling), ADR-0090 (dependency rule).

- Status: Accepted
- Related issues: #637, #706
- Related: ADR-0082, ADR-0090
