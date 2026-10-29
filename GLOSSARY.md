# AIHUB

AIHUB is a B2B multi-tenant AI API Gateway and identity broker. An Organization
authenticates to AIHUB, AIHUB enforces its policy and metering, then dispatches a
typed operation to a private AI service. This glossary covers structural and
stable integration terms; `CONTEXT.md` records current behavior and accepted
designs that are pending implementation.

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
every module shares. A Nest decorator is a seam too: `GradedRequest` and
`RequireOperation` are composed across modules by applying them, not by
resolving them, so no `exports:` array can ever list them. A dependency-cruiser
rule recognises a seam by file path, so it exempts a whole file rather than one
symbol within it (ADR-0066). Anything a module keeps to itself is its internals.
_Avoid_: public API, exported surface, barrel

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

**Request ID**:
An AIHUB-generated identifier for one HTTP request. The same value connects
the application's completion event, the response, and the proxy access record.
_Avoid_: caller-supplied request ID

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
obtained from either a Signed User Assertion or a Declared User ID.
_Avoid_: API-key owner ID

**Organization Identity Configuration**:
An Organization-owned policy for verifying end-user identity. When active, it
requires Signed User Assertions; when absent or disabled, it permits Declared
User IDs.
_Avoid_: JWKS health

**Signed User Assertion**:
A short-lived signed token issued by an Organization's backend that asserts an
End-User ID under that Organization's active identity policy.
_Avoid_: API key, plain user ID

**Declared User ID**:
A plain End-User ID supplied by an application when its Organization has no
active Identity Configuration; AIHUB does not cryptographically verify who it
identifies.
_Avoid_: signed assertion

**Customer Sandbox API key**:
An Organization-owned API key whose stored authorization permits the Sandbox
Environment. Its prefix does not grant access; the backend checks the key's
stored environment, scope, and Organization policy.

**Customer Production API key**:
An Organization-owned API key whose stored authorization permits Production;
its use may incur charges under the Organization's Production policy.

**Sandbox dispatch allowance**:
The maximum number of Sandbox grading dispatches admitted for one Organization
in one UTC calendar month, subject to the shared Sandbox ceiling.

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
