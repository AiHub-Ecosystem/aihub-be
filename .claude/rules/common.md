---
paths:
  - "src/common/**"
---

# Common layer rules

- Keep this layer limited to genuinely cross-cutting primitives: errors, request context, redaction, and transport-neutral utilities.
- Do not place organization policy, operation-specific behavior, or a repository in `src/common`.
- Explicitly named boundary bindings may import their framework; keep them isolated from the framework-neutral contracts beside them.
- Common code must not read raw headers, environment variables, Postgres, Redis, or downstream services unless the file is an explicit boundary adapter. Runtime configuration owns environment reads before Nest starts; common code consumes the validated configuration. `scripts/checks/check-architecture.spec.ts` pins that no common files read the environment directly.
- Reuse the shared error envelope and `RequestContext`; do not create module-specific duplicates.
- Reuse an existing `ErrorCode` where its meaning fits. A new one turns the CI job `Customer Web contract` red until `AiHub-Frontend` `dev` lists it in `data/aihub-contract/error-code-policy.json` (`messages` for its own copy, `safeGenericCodes` for the generic fallback), and a red CI on `main` skips deployment. Merge that Frontend change before pushing the code.
