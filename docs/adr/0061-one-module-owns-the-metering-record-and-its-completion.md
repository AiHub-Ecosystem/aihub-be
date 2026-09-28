# ADR-0061: One module owns the Metering record and its completion

- Status: Accepted
- Related issue: #181
- Related: [ADR-0016](0016-metering-boundary-and-billing-evidence.md), [ADR-0057](0057-graded-request-order-is-a-declared-contract.md), [ADR-0058](0058-concurrency-permit-is-acquired-and-released-by-one-unit.md)

A Metering record was assembled by side effect from four modules through a
module-level `WeakMap` keyed on the request, with fourteen optional fields and
no file that listed the lifecycle. Two callers raced to finish it and the
first one won, which was the only thing preventing a double write. The
request identity, the end-user actor, dispatch telemetry, and quota admission
were each recorded by whichever module happened to run first, and the record's
required shape was checked only where the record was consumed, fourteen
optional fields later.

The metering module owns the record, its vocabulary, and a single completion
path. The evidence one request has gathered lives on the request itself
(`request.aihubMetering`), in the same style as `aihubAuth`, `aihubIdentity`,
and `aihubConcurrency`, so there is no module-level mutable state left to
share. A required shape is validated where the record is built rather than
accumulated as optional fields, and the completion path is the only thing
that can claim a request, so two callers can no longer compete for it: the
race is settled inside one module instead of being visible across four. The
port and the Metering status vocabulary move out of the cross-cutting tree
into the metering business module, and the cross-cutting tree returns to
cross-cutting primitives. A request that never authenticates has no Metering
record, which is a business decision carried by ADR-0016 rather than a
side effect of validation; the completion path states it explicitly.

## Considered options

Keeping the cross-cutting store and only relocating it was rejected: it moves
the file without changing either of the two properties the issue exists to
fix, because the store stays module-level mutable state and the record is
still assembled by side effect. A request-scoped Nest provider was rejected:
the evidence is already attached to the request, so a second scope would
manage the same per-request lifetime for no gain. Letting the guards write
only the request fields they already own, with metering reading them back at
completion time, was rejected because the quota admission facts have nowhere
else to live and three guards would each become a second source of truth.
Leaving the writers in `common` was rejected because it makes the dependency
point inward, from the cross-cutting tree to a business module, and the port
it would need to reach for is one only metering owns.

Where the two callers of completion go was the sharper question. Keeping the
success envelope and the exception filter in `common` and importing the
metering port from there was rejected for the same reason: it creates exactly
the inward dependency this record is trying to remove, and it would do so
without any rule noticing. Moving only the interceptor was rejected because
the filter would keep the dependency alone. Splitting each file so the
cross-cutting half stayed in `common` and the metering half moved was
rejected because the token would then have to live in `common`, contradicting
the port's new home. Both callers therefore move into the metering module
beside the single completion path they call, and the global exception filter
is registered from its new home.

## Consequences

The metering port, the Metering status vocabulary, the telemetry normalizers,
and both completion callers live in the metering module, and the
cross-cutting `request-metering` tree is removed. A dependency-cruiser rule
forbidding `src/common` from importing `src/modules` enforces that boundary
from now on; without it the inward dependency could return unnoticed.

Evidence is created lazily, so the request-start metering hook is no longer
needed. A failed request's `total_ms` now comes from Fastify's own response
window, which starts once the reply is being sent, so a recorded failure no
longer includes body-parse time; that mattered most for large multipart
uploads, and it is a narrowing of a recorded value rather than a guess at a
new one. A successful request keeps measuring from its own interceptor, so
the two windows stay deliberately different, as they are today; unifying them
changes recorded durations and is a separate decision. Removing the hook also
removes the only reader of the recorded receive time, which was never carried
into a Metering record.

The one-call-twice case is still covered by a behaviour test that calls the
filter twice and asserts a single record, so the guarantee is proven at the
boundary rather than against the claiming mechanism.
