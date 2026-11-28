# AIHUB

AIHUB is a B2B multi-tenant AI API Gateway and identity broker. An Organization
authenticates to AIHUB, AIHUB enforces its policy and metering, then dispatches a
typed operation to a private AI service. This glossary covers structural and
stable integration terms; `CONTEXT.md` records current behavior and accepted
designs that are pending implementation.

## Language

**Deploy identity**:
The SSH identity used by continuous deployment to release AIHUB. It can update
AIHUB workloads but is not trusted with host-root authority; host maintenance
and shared-host configuration remain operator responsibilities.
_Avoid_: root deploy account

**Business module**:
A capability area of the application under `src/modules`: auth, avatar,
content-proxy, gateway, idempotency, identity, metering, persistence, secrets,
speaking, uploads, or writing. A module owns its use cases, vocabulary, and
adapters, and is meant to change without its neighbours changing.
_Avoid_: service, package, bounded context

**Module public seam**:
What one business module exposes for another to use, which is exactly what its
Nest module lists in `exports:` — plus the module class itself for wiring, and
any file that declares `module 'fastify'` because it extends the request type
every module shares. A Nest decorator is a seam too: `GradedRequest` and
`RequireOperation` are composed across modules by applying them, not by
resolving them, so no `exports:` array can ever list them. A dependency-cruiser
rule recognises a seam by file path, so it exempts a whole file rather than one
symbol within it (ADR-0066). Anything a module keeps to itself is its internals.
_Avoid_: public API, exported surface, barrel

**Dependency seam**:
One AIHUB consumer or policy boundary that uses a dependency and has its own
degraded behavior. A dependency can serve several seams, such as Redis-backed
rate limiting, quota admission, and concurrency admission.
_Avoid_: dependency row

**Module internals**:
A file inside another business module that is not part of that module's public
seam. Importing one couples two modules that should be able to change apart.
_Avoid_: private file, implementation

**Public API Major Version**:
A versioned generation of the whole Public API Contract, covering dispatch
operations and non-dispatch Public API Routes. Compatible changes stay within
the current major; a breaking contract change requires a new major.
_Avoid_: package version, endpoint version

**API Compatibility Window**:
The transition period after a successor major is released during which the
preceding major remains supported. AIHUB sets a minimum of 12 months, publishes
the sunset date, and requires an explicit decision to extend it.
_Avoid_: rollback window

**Public API Contract Version**:
The SemVer identifier of a released Public API Contract, independent of the
backend package version. Its major number matches the Public API Major Version.
_Avoid_: package version

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

**Graded admission**:
The single decision on a graded request that applies the API key's rate limit,
then the Organization retry budget, then the monthly quota, in the order
[ADR-0057](docs/adr/0057-graded-request-order-is-a-declared-contract.md)
declares. It is distinct from Request admission and Organization admission; the
Concurrency permit is a separate step after it.
_Avoid_: gateway check, quota check

**Job quota reservation**:
One accepted Speaking grading job that occupies a unit of its Organization's
monthly request quota until metering has accounted for it. It is independent
of the Concurrency permit held during dispatch.
_Avoid_: dispatch reservation, in-flight request

**Sandbox dispatch reservation**:
The durable claim of one unit of an Organization's Sandbox dispatch allowance
for one accepted submit. It is spent when the request reaches the dispatch
boundary, even when the downstream call later fails.
_Avoid_: job quota reservation, quota counter

**In-flight jobs**:
Speaking grading jobs whose job quota reservation is still active: queued,
running, or succeeded before the metering handoff.
_Avoid_: Concurrency permit, HTTP stream

**Concurrency permit**:
The right for one graded request to occupy one of its Organization's in-flight
dispatch slots, acquired after Graded admission and released when the request
settles. A permit held past the response by background work ages out after the
stale-lease window. It is admission control, not usage evidence, and is separate
from a Job quota reservation.
_Avoid_: job quota reservation, in-flight jobs

**Organization retry budget**:
The Organization-wide allowance for same-key repeats of operations that
support idempotency, shared by its API keys and distinct from monthly quota. It
is a rolling 60-second allowance of at most 10% of first attempts, with a
minimum of one repeat per Organization.
_Avoid_: per-key retry limit

**Request ID**:
An AIHUB-generated identifier for one HTTP request. The same value connects
the application's completion event, the response, and the proxy access record.
_Avoid_: caller-supplied request ID

**Observability context boundary**:
The only scopes where request context may be carried implicitly: OpenTelemetry
trace context and request-log bindings. Business logic receives organization
identity, request ID, and other request context explicitly.
_Avoid_: tracing boundary when it excludes log bindings, implicit context store

**AIHUB response deadline**:
The maximum time from request receipt that AIHUB gives a synchronous caller to
receive its response. It does not end required-idempotency Writing work that is
still running in the background.
_Avoid_: downstream work deadline

**Dispatch work deadline**:
The latest time AIHUB permits one outbound AI Service call to keep running. It
is sent as the remaining milliseconds in `x-request-deadline`; required-
idempotency Writing uses its separate hard work deadline after the response
deadline expires.
_Avoid_: caller response timeout

**Observed caller IP**:
The network address AIHUB attributes to the request at ingress. It can identify
an intermediary, such as the Customer Web BFF, rather than the end user; the
recorded source must make that distinction explicit.
_Avoid_: end-user IP (unless verified forwarding is in place)

**Caller-and-address budget**:
A per-caller allowance for requests concerning one email address. It prevents one
caller's repeated attempts from consuming every other caller's allowance.
_Avoid_: email-only caller key

**Authentication email ceiling**:
A shared maximum for queued verification and password-recovery emails to one
email address in a 24-hour window, across registration, verification resend, and
password recovery.
_Avoid_: per-route email cap

**Email Send Rate Cap**:
The maximum aggregate request rate AIHUB permits for sends to one email-provider
account, shared across every AIHUB instance using that account.

**Email Provider Outage**:
A period when the Resend account cannot accept delivery requests because of
provider rate limiting, service failure, timeout, or connection failure. A
message-specific rejection and a credential configuration problem are separate
conditions.

**Email Daily Send Budget**:
A maximum number of outbound email attempts AIHUB may reserve per UTC calendar
day across all deployments using one provider account. Organization Invitations
may use only a configured share, preserving capacity for verification,
password-reset, and MFA email; every attempt counts, including provider failures.
_Avoid_: Email Send Rate Cap, which limits attempts over a shorter time interval.

**Email Dispatch Fair Share**:
A maximum share of invitation sends attributable to one Organization or inviter
while other Organizations or inviters have queued invitation sends.
_Avoid_: the Organization Invitation Send Limit, which bounds invitation attempts
when they are created.

**Personal-data classification**:
An operational description of what personal data represents, such as a direct
identifier, credential, user content, pseudonymous identifier, or metadata; it
does not make a legal determination.
_Avoid_: legal category

**End-User ID**:
The identifier AIHUB associates with a user's operation and usage record. It is
obtained from either a Signed User Assertion or a Declared User ID, resolves for
metering and downstream `user_id`/`sub`, and is compared exactly as sent, never
case-folded or normalized — one end user must always use the same value.
_Avoid_: API-key owner ID

**AIHUB User Account**:
The person-level account AIHUB manages for user-facing access; it is distinct
from an Organization and its API keys, and may belong to zero or more
Organizations through Organization Membership.
_Avoid_: customer account (ambiguous between a person and an Organization)

**User Access JWT revocation**:
Invalidating one issued User Access JWT before its normal expiry. It leaves
sibling JWTs and the account's login sessions active.
_Avoid_: session revocation

**Organization Identity Configuration**:
An Organization-owned policy for verifying end-user identity. When active, it
requires Signed User Assertions; when absent or disabled, it permits Declared
User IDs. It records the issuer, a JWKS URL or inline public JWKS, allowed
algorithms, maximum assertion TTL, and active/disabled status. Self-service URL
claims require the issuer and JWKS host to match; inline keys are
operator-provisioned, and an operator releases a claim by disabling the
configuration and recording an audit event
([ADR-0191](docs/adr/0191-organization-identity-issuer-control-and-release.md)).
_Avoid_: JWKS health

**Identity Cache Entry**:
A temporary copy of API-key authorization data or an Organization's public
verification keys that AIHUB uses while making an identity decision. It is
derived from an authoritative source and never becomes a source of truth.
_Avoid_: durable identity record

**Identity Cache Integrity**:
The guarantee that an Identity Cache Entry may affect authentication only when
AIHUB validates its origin and original validity window. If the verification key
is not configured, Redis entries are bypassed. An unverified entry cannot
authenticate a request or verify an assertion.
_Avoid_: cache trust

**Identity Cache Freshness Deadline**:
The absolute time until an Identity Cache Entry may be used. Storage expiry may
shorten this window but cannot extend it.
_Avoid_: cache TTL

**Signed User Assertion**:
A short-lived signed token issued by an Organization's backend that asserts an
End-User ID under that Organization's active identity policy and is verified
through that Organization's JWKS. A plain value from such an Organization is
rejected, never downgraded.
_Avoid_: API key, plain user ID

**Declared User ID**:
A plain End-User ID supplied by an application when its Organization has no
active Identity Configuration. AIHUB neither cryptographically verifies who it
identifies nor interprets the value; an email address is accepted but stored
and forwarded as-is.
_Avoid_: signed assertion

**Customer Sandbox API key**:
An Organization-owned API key whose stored authorization permits the Sandbox
Environment. Its prefix does not grant access; the backend checks the key's
stored environment, scope, and Organization policy. Creation permits only
`writing.grade`, `speaking.grade`, or both, and the public demo checks the
selected skill's scope ([ADR-0094](docs/adr/0094-sandbox-demo-key-admission.md)).

**Customer Production API key**:
An Organization-owned API key whose stored authorization permits Production;
its use may incur charges under the Organization's Production policy.

**Sandbox dispatch allowance**:
The maximum number of Sandbox grading dispatches admitted for one Organization
in one UTC calendar month, subject to the shared Sandbox ceiling. Each
Organization receives five from the persisted default, shared across every key,
client, and Writing/Speaking skill, with a shared ceiling of 500; a
month-specific override replaces that default without resetting consumption
and expires with the month, and a month with no persisted default fails closed.
Dispatches reaching the boundary count despite downstream failure or timeout,
while completed successful Writing replays consume none.

**Sandbox allowance override**:
A month-specific total Sandbox dispatch allowance for one Organization that
replaces the default for that month; it is not an additive bonus.

**User identity mode**:
The `user_identity_mode` signal a successful demo key validation reports:
`signed_assertion` when the Organization has an active Identity Configuration,
`declared_id` otherwise. It selects which identity input the demo collects; it
carries no issuer, JWKS, or key detail, and it authorizes nothing on its own.
_Also known as_: `user_identity_mode`

**Writing Task 1 chart asset**:
An AIHUB-published chart image attached to a Writing Task 1 request. Its URL is
publicly readable until its 24-hour expiry or earlier revocation; Organization
and End-User ownership scope upload and completion, not public reads
([ADR-0100](docs/adr/0100-writing-task1-chart-image-uploads.md),
[ADR-0101](docs/adr/0101-writing-charts-use-shared-seaweedfs-host.md),
[ADR-0111](docs/adr/0111-revoke-reported-public-writing-charts.md)).

**Public route convention**:
The naming and response rules every new Public API Route follows: a verb for
actions, a prefix that separates exam content from skill assets, one rule for
what a delete answers, and a fixed place for `me`. Routes published before it
stay as they are and are listed with the reason ([ADR-0129](docs/adr/0129-public-route-and-response-convention.md)).

**Grading behavior change**:
A change to the model, prompt, or rubric and evaluation of an AI Service that can
move the bands it returns for the same input, whether or not the response shape
changes. It is not a breaking contract change: it neither bumps the Public API
Contract Version nor starts a new major. Customers are told through the grading
changes log ([ADR-0131](docs/adr/0131-customers-are-told-when-grading-behavior-changes.md)).
_Avoid_: model upgrade, contract change

**Writing priority error**:
A writing issue selected and ranked for the learner to address, with its error
code and a short explanation of why it matters.
_Avoid_: progress insight (the broader analysis of a learner's writing history)

**Downstream fault**:
An AI Service answer that counts against the service's health: every 5xx, and a
401 or 403 because AIHUB's own credential was rejected rather than the
customer's input. A circuit breaker counts it, and an idempotency attempt it
ends is kept as failed. Other 4xx answers blame the request; 408 and 425 are
retryable but are not a downstream fault.

**Upload session**:
A bounded customer upload: the private bytes staged for it, the published artifact
they may become, and the owner and environment bound at creation. A Writing chart
upload is one specialization.
_Avoid_: upload intent, upload request

**Staged object**:
The private bytes uploaded for one upload session before publication.
_Avoid_: staging blob

**Byte verification**:
The check and re-encoding a feature applies to staged bytes before they become a published artifact. A feature whose storage only describes an object publishes that object without byte verification.
_Avoid_: sanitization, verification stub

**Published artifact**:
The immutable object an upload session becomes after verification. Access
follows the feature's policy. A Speaking Audio asset remains private after
publication.
_Avoid_: final object

**Publication record**:
The durable record binding a published artifact to its owner, environment, and
retention deadline.
_Avoid_: completed upload

**Writing chart upload**:
The short-lived record of one customer chart upload: a private staging object and
the public object it becomes. It is `open` until completed, `rejected` when
refused or revoked, `publishing` while the public object is being written, and
`published` once it is a Writing Task 1 chart asset. Removing an expired upload
removes both objects, whatever state it was in.
_Avoid_: intent, candidate (code terms for a stage of the record, not the record)

**Writing chart revocation**:
Ending public serving of an AIHUB-published chart before its natural expiry.
It stops access through AIHUB-controlled serving; it cannot retrieve copies
others already downloaded or independently cached.
_Avoid_: deletion (without qualification), which can imply every copy is gone.

**Capacity action trigger**:
A policy that connects measured resource and dependency signals, evidence-based
thresholds and windows, remaining headroom, and a human capacity response. It
names who approves cost-bearing action and the time needed to carry it out; it
does not resize automatically.
_Avoid_: autoscaling rule
