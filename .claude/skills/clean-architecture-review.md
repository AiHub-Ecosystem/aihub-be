# Skill: Clean Architecture review

Use for a non-trivial AIHUB change.

1. Identify the changed layer and its allowed dependencies.
2. Trace the request from presentation through application ports to infrastructure.
3. Confirm domain/application code has no framework, transport, environment, database, cache, or downstream imports.
4. Confirm adapters are pure and trusted hosts/tokens are injected by infrastructure.
5. Run `pnpm arch-check`, focused tests, and `pnpm type-check`.
6. Report the smallest boundary fix; do not introduce a new abstraction for a one-off dependency.
