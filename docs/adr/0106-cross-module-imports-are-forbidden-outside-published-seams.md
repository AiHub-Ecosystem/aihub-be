# Cross-module imports are forbidden outside published seams

The cross-module import rule (`no-cross-module-internal-import`) is an error, not a warning: any business module importing another module's internal path fails `pnpm arch-check` unless the target is one of the published seams (module composition root, `application/**.port.ts` contracts, a presentation primitive declaring `module 'fastify'`, a Nest `exports:` declaration, a `public/` facade, or a Nest decorator). This supersedes ADR-0066, whose "checked, not yet forbidden" stance no longer reflects the enforced rule.

- Status: Accepted (supersedes ADR-0066)
- Related issue: #764
