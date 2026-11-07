# ADR-0155: Use NestJS CQRS Buses for Organization API-Key Management

- Status: Accepted
- Date: 2026-11-07
- Related: [#1682](https://github.com/AiHub-Ecosystem/aihub-be/issues/1682), [#323](https://github.com/AiHub-Ecosystem/aihub-be/issues/323), [ADR-0154](0154-decline-event-sourcing-for-organization-api-keys.md)

## Context

Organization API-key management already has framework-free application use cases for create, rotate, revoke, and list. The HTTP controller previously invoked those use cases directly. Issue #1682 pilots the official `@nestjs/cqrs` package at this boundary to evaluate its synchronous command and query dispatch without changing the existing PostgreSQL-backed behavior.

## Decision

Adopt `@nestjs/cqrs` for the Organization API-key management routes. Create, rotate, and revoke dispatch through `CommandBus`; list dispatches through `QueryBus`. Handlers remain in the Identity API-key `presentation/` layer and delegate to the existing application ports and use cases. The application layer remains framework-free, and the list query reads the existing PostgreSQL source through its application port.

The adoption is limited to synchronous request dispatch. It does not use `EventBus`, domain events, asynchronous handlers, projections, a separate read model, or Event Sourcing. PostgreSQL remains the source of truth, with existing authorization, Organization scoping, audit writes, transactions, idempotency, response contracts, and one-time secret disclosure owned by the existing use cases and repository.

## Consequences

- The four HTTP operations now have explicit command/query handler boundaries that can be exercised through the Nest buses.
- The package adds a CQRS vocabulary and runtime dependency without moving business behavior out of application use cases.
- This pilot does not establish a general mandate to migrate other modules or operations to CQRS; adopt it elsewhere only when a concrete dispatch need is demonstrated.
- Event Sourcing remains declined under ADR-0154; the CQRS buses do not provide evidence for changing that decision.
