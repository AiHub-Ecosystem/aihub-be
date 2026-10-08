# Skill: New AIHUB endpoint

Use for a new public route.

1. Map the route to one operation ID and a canonical TypeBox schema.
2. Make organization identity, scope, idempotency, body limit, and timeout explicit in the catalog.
3. Keep controllers thin and pass `RequestContext` into an application port.
   For Identity routes, put the controller and route specs in `src/modules/identity/<feature>/presentation/`, with the use case, port, and application specs in the same feature's `application/` folder.
4. Use pure request/response adapters and a separate I/O dispatcher.
5. Add boundary, error, and adapter tests.
6. Stop if the downstream response is unresolved; use the explicit contract blocker instead of guessing.
