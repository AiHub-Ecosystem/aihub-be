# AIHUB

AIHUB is a B2B multi-tenant AI API Gateway and identity broker. An Organization
authenticates to AIHUB, AIHUB enforces its policy and metering, then dispatches a
typed operation to a private AI service. This glossary covers the structural
language of the module tree; the business vocabulary lives in `CONTEXT.md`.

## Language

**Business module**:
A capability area of the application under `src/modules`: auth, gateway,
idempotency, identity, metering, secrets, speaking, or writing. A module owns its
use cases, vocabulary, and adapters, and is meant to change without its
neighbours changing.
_Avoid_: service, package, bounded context

**Module public seam**:
What one business module is allowed to reach of another. The seam is three
things: the module's `<module>.module.ts` composition root, its
`application/**/*.port.ts` contracts, and a presentation primitive that
declares `module 'fastify'` because it extends the shared request type. Anything
else in another module is its internals (ADR-0066).
_Avoid_: public API, exported surface, barrel

**Module internals**:
A file inside another business module that is not part of that module's public
seam. Importing one couples two modules that should be able to change apart.
_Avoid_: private file, implementation

**Shared presentation primitive**:
A presentation file that declares `module 'fastify'` to extend the request type
every module already agrees on, such as the accessor for `aihubAuth` or the
evidence attached at `aihubMetering`. Being shared is a property the file
declares, never a label someone assigns to it.
_Avoid_: common helper, cross-cutting utility

**Application port**:
An interface a module declares in its own `application` layer to name what it
needs from the outside, bound to a concrete implementation at its composition
root. A port is how one business module asks another for behaviour without
depending on how that behaviour is built.
_Avoid_: interface, contract, adapter

**Composition root**:
The `<module>.module.ts` file where a Nest module binds its application ports to
concrete implementations. It is the only place infrastructure is wired, and the
only place another module is imported for wiring rather than for behaviour.
_Avoid_: module file, bootstrap, wiring

**Graded-request chain**:
The declared order in which a graded request authenticates, resolves the
End-User ID, applies rate limits, checks quota, and takes a concurrency slot
(ADR-0057). The order is observable behaviour, because it decides whether a
caller receives `RATE_LIMITED` or `QUOTA_EXCEEDED`.
_Avoid_: middleware stack, guard chain, request pipeline
