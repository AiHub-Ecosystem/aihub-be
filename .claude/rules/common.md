---
paths:
  - "src/common/**"
---

# Common layer rules

- Keep this layer limited to genuinely cross-cutting primitives: errors, request context, redaction, and transport-neutral utilities.
- Do not place organization policy, operation-specific behavior, or a repository in `src/common`.
- Explicitly named boundary bindings may import their framework; keep them isolated from the framework-neutral contracts beside them.
- Common code must not read raw headers, environment variables, Postgres, Redis, or downstream services unless the file is an explicit boundary adapter. The adapters that may read the environment are `observability/open-telemetry.ts` and `observability/request-logger.ts`; `scripts/check-architecture.spec.ts` pins that list.
- Reuse the shared error envelope and `RequestContext`; do not create module-specific duplicates.
