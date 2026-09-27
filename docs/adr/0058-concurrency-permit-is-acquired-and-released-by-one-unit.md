# ADR-0058: A concurrency permit is acquired and released by one unit

- Status: Accepted
- Related issue: #172
- Related: [ADR-0057](0057-graded-request-order-is-a-declared-contract.md), [ADR-0018](0018-monthly-quota-enforcement.md)

A graded request's concurrency slot was acquired in one guard and released in a different interceptor, with nothing binding the pair. The two halves sit on opposite sides of the handler, so a route could be registered with the acquire half and not the release half: every request would then hold its slot until the stale-lease window (120s) pruned it, with no gate noticing, and the operator-visible symptom was that concurrent request counts fell on their own under load. The release interceptor also skipped silently when the permit was absent and read the permit once on the unasserted assumption that the guard had already run.

We fuse acquire and release into a single concurrency-permit interceptor, provided once by the composition root and applied by the declared graded-request chain. Because both halves live in one class and the release half closes over the permit the acquire half created, a route cannot hold the acquire half without the release half; the defect becomes structurally impossible rather than discouraged, and there is no longer a separate guard and interceptor whose load order had to be assumed. The request keeps carrying the permit only because the Writing controller reads the background lifecycle from it.

## Considered options

Binding the existing guard and interceptor with a single decorator was rejected. It preserves current behaviour exactly and leaves the order work untouched, but it keeps two classes: a developer can still register the acquire half alone, so the guarantee holds only by convention, and the load-ordering assumption — the interceptor reading the permit before the guard had demonstrably set it — survives unchanged. Moving the release into the guard and hooking the response from there was rejected because a guard cannot observe the handler's observable, so the request-settled trigger and the background-work hold would be lost, which the acceptance criteria require preserving. Registering the unit globally as a guard or interceptor was rejected because only graded routes cap downstream work; the repository deliberately binds only a global exception filter.

## Consequences

The acquire phase moves from a guard to an interceptor. The net observable behaviour is unchanged: both run before the handler and before the success envelope, so the refusal, its status, and its retry hint are identical and metering finalizes the same way. The declared-order guarantee survives: the order test records the guard sequence and the interceptor's acquire as one sequence, so quota is still proven to be read before a slot is taken, now across the guard/interceptor boundary. The permit's internal state machine and the limiter lease are untouched, so one-shot release and the background-work lifecycle are preserved by construction, including the existing asymmetry in which Writing holds the permit for detached background work and Speaking does not. The old silent skip, where a permit that could not be read was passed over without a word, is gone: the release no longer depends on any mutable request field, so the failure it guarded against can no longer be expressed.
