---
paths:
  - "src/**/infrastructure/**"
  - "src/downstream/**"
---

# Infrastructure and downstream rules

- Infrastructure implements application ports and owns I/O, retries, timeouts, cancellation, connection clients, and configuration access.
- Downstream adapters are pure mappers. They receive a path from the operation catalog and must not choose a client-controlled host or call the network.
- Keep explicit domain-to-persistence and persistence-to-domain mappers; unsafe casts are not a mapper.
- Redact API keys, assertions, internal tokens, essays, and raw downstream bodies before logging or attaching error details.
- Do not import another module's infrastructure. Share behavior through an application port.
- Redis is never the durable source of truth for identity, usage, quota, or idempotency.
