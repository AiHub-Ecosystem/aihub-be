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
What one business module exposes for another to use, which is exactly what its
Nest module lists in `exports:` — plus the module class itself for wiring, and
any file that declares `module 'fastify'` because it extends the request type
every module shares. A dependency-cruiser rule can only see this by file path,
so it recognises the module file, `application/**/*.port.ts`, and shared
primitives; it cannot read an `exports:` array (ADR-0066). Anything a module
keeps to itself is its internals.
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

**Graded-request chain**:
The declared order in which a graded request authenticates, resolves the
End-User ID, applies rate limits, checks quota, and takes a concurrency slot
(ADR-0057). The order is observable behaviour, because it decides whether a
caller receives `RATE_LIMITED` or `QUOTA_EXCEEDED`.
_Avoid_: middleware stack, guard chain, request pipeline
