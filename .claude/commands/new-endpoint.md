# Add an endpoint

Before creating a controller or route:

1. Read the public contract and the matching implementation spec.
2. Add a distinct operation catalog entry with path, scope, identity mode, limits, timeout, and idempotency policy.
3. Add the TypeBox request and known response contract; keep Task1 and Task2 schemas separate.
4. Decide how `RequestContext` and user identity are built.
   For Identity routes, place controllers and route specs in `src/modules/identity/<feature>/presentation/`; place the use case, port, and application specs in that feature's `application/` folder.
5. Add a pure downstream mapper and application port; keep I/O in infrastructure.
6. Write focused boundary, mapper, and error tests before implementation.
7. If the downstream response shape is unknown, stop at `responseContract: 'unresolved'` and record the blocker; never invent a parser.

Finish with `pnpm type-check`, `pnpm arch-check`, and the focused Jest command.
