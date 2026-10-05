# ADR-0073: Single-adapter seams keep their DI ceremony; no ceremony removal in #244

- Status: Accepted
- Date: 2026-10-05
- Related issues: [#244](https://github.com/AiHub-Ecosystem/aihub-be/issues/244)
- Related: [ADR-0066](0066-cross-module-imports-are-checked-not-yet-forbidden.md)

## Context

Issue #244 measured which seams are real before any ceremony is removed. A seam earns its place when something actually varies across it. Today the variation is easy to name: durable records swap between Postgres and a test fake, Redis has a real client and a fake, S3 and Vault each have one adapter plus a fake, and the grading dispatcher and orchestrator have fakes behind their tokens. Those seams stay.

Issue #244's count, taken on 2026-10-04, was twenty-six single-method ports with one Symbol token and one production binding in exactly one composition root, none bound to a second implementation by any spec. The recount for this ADR, run on 2026-10-05 across `src/modules/*/application/*.port.ts`, finds thirty-five: twenty-one in Identity, three in Auth, five in Gateway, one in Idempotency, two in Metering, two in Speaking, one in Secrets. The delta is the accepted new surface since 2026-10-04 (gateway operation types, identity rename/creation record ports), plus ports counted with optional members today.

Every one of the thirty-five passes the "one production binding, no second production implementation" test, so by the one-adapter/one-seam measure they are all hypothetical seams. The next question is whether their Symbol tokens, composition-root provider entries, and `exports:` entries are ceremony around a type that already does the work, and what removing that ceremony would cost.

## Evidence per port

Method counts below include optional members. "Impls in specs" counts implementations beyond the production one. "Spec override" records whether any spec overrides the DI token rather than only substituting a plain object.

| Module      | Port interface                      | Token                                |            Methods | Production binding                     | Impls in specs  | Spec override via token | Files touched if ceremony removed                           |
| ----------- | ----------------------------------- | ------------------------------------ | -----------------: | -------------------------------------- | --------------- | ----------------------- | ----------------------------------------------------------- |
| Identity    | AcceptOrganizationInvitationPort    | `ACCEPT_ORGANIZATION_INVITATION`     |                  1 | identity.module.ts:408                 | 0               | via driven ports        | port + module + 1 controller                                |
| Identity    | ApiKeyAuthenticatorPort             | `API_KEY_AUTHENTICATOR`              |                  1 | :445, exported :510                    | plain literals  | some specs              | port + module + 3 guards + 5 spec files                     |
| Identity    | CreateOrganizationApiKeyPort        | `CREATE_ORGANIZATION_API_KEY`        |                  1 | :298                                   | 0               | 0                       | port + module + 1 controller                                |
| Identity    | CreateOrganizationPort              | `CREATE_ORGANIZATION`                |                  1 | :269                                   | 0               | 0                       | port + module + 1 controller                                |
| Identity    | ListOpenOrganizationInvitationsPort | `LIST_OPEN_ORGANIZATION_INVITATIONS` |                  1 | :416                                   | 0               | 0                       | port + module + 1 controller                                |
| Identity    | ListOrganizationApiKeysPort         | `LIST_ORGANIZATION_API_KEYS`         |                  1 | :345                                   | 0               | 0                       | port + module + 1 controller                                |
| Identity    | OrganizationAuditEventReadPort      | `ORGANIZATION_AUDIT_EVENT_READ`      |                  1 | :306                                   | 1               | yes                     | port + module + 1 controller + 2 specs                      |
| Identity    | OrganizationCreationRecordPort      | `ORGANIZATION_CREATION_RECORD`       |                  1 | :264                                   | 1               | yes                     | port + module + 2 specs                                     |
| Identity    | OrganizationMembershipListPort      | `ORGANIZATION_MEMBERSHIP_LIST`       |                  1 | :246 (`useExisting`)                   | 0               | 0                       | port + module                                               |
| Identity    | OrganizationRenameRecordPort        | `ORGANIZATION_RENAME_RECORD`         |                  1 | :282                                   | 1               | yes                     | port + module + 1 integration spec                          |
| Identity    | ReadOrganizationAuditEventsPort     | `READ_ORGANIZATION_AUDIT_EVENTS`     |                  1 | :311                                   | 0               | 0                       | port + module + 1 controller                                |
| Identity    | ReadOrganizationIdentityConfigPort  | `READ_ORGANIZATION_IDENTITY_CONFIG`  |                  1 | :319                                   | 0               | 0                       | port + module + 1 controller                                |
| Identity    | RenameOrganizationPort              | `RENAME_ORGANIZATION`                |                  1 | :287                                   | 0               | 0                       | port + module + 1 controller                                |
| Identity    | RevokeOrganizationApiKeyPort        | `REVOKE_ORGANIZATION_API_KEY`        |                  1 | :362                                   | 0               | 0                       | port + module + 1 controller                                |
| Identity    | RevokeOrganizationInvitationPort    | `REVOKE_ORGANIZATION_INVITATION`     |                  1 | :424                                   | 0               | 0                       | port + module + 1 controller                                |
| Identity    | RotateOrganizationApiKeyPort        | `ROTATE_ORGANIZATION_API_KEY`        |                  1 | :353                                   | 0               | 0                       | port + module + 1 controller                                |
| Identity    | SandboxAssertionMinterPort          | `SANDBOX_ASSERTION_MINTER`           |                  1 | :492                                   | 0               | 0                       | port + module + 1 controller                                |
| Identity    | SandboxAssertionSignerPort          | `SANDBOX_ASSERTION_SIGNER`           | 1 (+readonly prop) | :488                                   | 1               | 0                       | port + module + 1 spec                                      |
| Identity    | SetOrganizationIdentityConfigPort   | `SET_ORGANIZATION_IDENTITY_CONFIG`   |                  1 | :330                                   | 0               | 0                       | port + module + 1 controller                                |
| Identity    | UserAssertionCryptoPort             | `USER_ASSERTION_CRYPTO`              |                  2 | :477                                   | 1               | 0                       | port + module + 1 spec                                      |
| Identity    | UserIdentityResolverPort            | `USER_IDENTITY_RESOLVER`             |                  1 | :460, exported :514                    | plain literals  | yes                     | port + module + 2 guards + 1 spec                           |
| Auth        | AuthRateLimiterPort                 | `AUTH_RATE_LIMITER`                  |                  1 | auth.module.ts:134, exported :172      | 3               | yes                     | port + auth.module + 3 specs                                |
| Auth        | UserAccessTokenIssuerPort           | `USER_ACCESS_TOKEN_ISSUER`           |                  1 | :160                                   | 2               | yes                     | port + auth.module + 1 service + many specs                 |
| Auth        | UserAccessTokenVerifierPort         | `USER_ACCESS_TOKEN_VERIFIER`         |                  1 | :164, exported :178                    | plain literals  | many                    | port + auth.module + 1 guard + many specs                   |
| Gateway     | ConcurrencyLimiterPort              | `CONCURRENCY_LIMITER`                |                  1 | gateway.module.ts:96, exported :158    | 1               | yes                     | port + gateway.module + 1 interceptor + 1 spec              |
| Gateway     | GradingOrchestratorPort             | `GRADING_ORCHESTRATOR`               |                  1 | :138, exported :152                    | real instance   | no                      | port + gateway.module + 2 controllers/specs                 |
| Gateway     | InternalTokenIssuerPort             | `INTERNAL_TOKEN_ISSUER`              |                  1 | :82                                    | 1               | 0                       | port + gateway.module + 1 spec                              |
| Gateway     | OperationDispatcherPort             | `OPERATION_DISPATCHER`               |                  1 | :114, exported :151                    | several         | yes                     | port + gateway.module + 1 gateway spec + several specs      |
| Gateway     | RateLimiterPort                     | `RATE_LIMITER`                       |                  1 | :90, exported :154                     | plain literals  | yes                     | port + gateway.module + 1 guard + 3 specs                   |
| Idempotency | IdempotencyServicePort              | `IDEMPOTENCY_SERVICE`                |                  1 | idempotency.module.ts:22, exported :28 | plain literals  | yes                     | port + idempotency.module + gateway.module + several specs  |
| Metering    | MeteringFinalizerPort               | `METERING_FINALIZER`                 |                  1 | metering.module.ts:44                  | 1               | yes                     | port + metering.module + 1 filter + 1 interceptor + 2 specs |
| Metering    | MeteringFailureLoggerPort           | `METERING_FAILURE_LOGGER`            |                  1 | :40                                    | 0               | 0                       | port + metering.module                                      |
| Speaking    | SpeakingAudioStoragePort            | `SPEAKING_AUDIO_STORAGE`             |                  1 | speaking.module.ts:96                  | 1               | plain object into ctor  | port + speaking.module + 1 controller + 1 spec              |
| Speaking    | SpeakingMultipartParserPort         | `SPEAKING_MULTIPART_PARSER`          |                  1 | :103                                   | 0               | instance property patch | port + speaking.module + 1 controller + 1 spec              |
| Secrets     | RuntimeSecretProvider               | `RUNTIME_SECRET_PROVIDER`            |                  1 | secrets.module.ts:9, exported :13      | inline literals | yes                     | port + secrets.module + 4 dependent module imports + 1 spec |

Ports with no Symbol token, no provider, and a CLI-constructed repository (`OperatorApiKeyPort`, `OrganizationEntitlementPort`, `OrganizationFirstOwnerPort`, `OrganizationStatusPort`) are not hypothetical seams in the DI sense: the port interface is still the seam, the seam materializes in the CLI option seam, and removing the interface would remove the only boundary `src/cli` has. They are out of scope.

Controller and HTTP specs overwhelmingly build `Test.createTestingModule({ imports: [AppModule] })` and then `overrideProvider(TOKEN).useValue(...)` for the driven ports they want isolated. Driving-port tokens (`CreateOrganizationPort`, `RenameOrganizationPort`, the five API-key verbs, invitation verbs, audit-event read, identity-config read/set, sandbox assertion minter) are never overridden anywhere: their controller specs substitute at the driven-port level and let the real application service run. That is the evidence that those driving seams are hypothetical; it is also the evidence for the cost of removal.

## Cost of removal

The honest measurement is that the cost is concentrated, not spread. Deleting the ceremony for an Identity port touches, on average: the port file, `identity.module.ts` (import, provider entry, inject list, likely exports list), the one or two consumers' `@Inject` sites, and every controller spec that builds `AppModule` overrides for the surrounding driven ports (the override mechanisms reference the same tokens). The Identity composition root and roughly a dozen controller specs plus three integration specs are most of the bill; a repo-wide estimate for all thirty-five is on the order of fifty files, dominated by `identity.module.ts`, `auth.module.ts`, and the controller/integration specs of the Identity, Auth, and Gateway surfaces.

What removal buys: one less Symbol per port, one less provider entry, one less `exports` entry. What it loses: the uniform HTTP-lane trick of swapping the driven port for a fake in `AppModule`, and the `exports:`-driven cross-module visibility check that ADR-0066 builds on. Every controller spec would need to construct its service graph by constructor, which the application unit specs already do; the win would be real but stylistic, and every future seam introduced "for real" would then need the ceremony re-added.

## Decision

Keep the DI ceremony for all thirty-five entries. The measurement confirms the seams are hypothetical today, and the decision is to keep the ceremony anyway, for three reasons:

1. The ceremony is uniform across the repo, and uniformity is what lets a reader tell a driving port from a driven one and a module's public seam from its internals. Removing it for the hypothetical cases would make the real cases' ceremony look arbitrary.
2. The HTTP controller-spec pattern (`AppModule` + `overrideProvider` on driven ports) is the repo's tested lane-isolation mechanism. Driving-port tokens participate in it even when never overridden themselves, because the driving service is wired by the same factory graph. Removing the tokens removes the seam the pattern depends on.
3. The cost is concentrated in the Identity composition root and the controller specs, which is exactly the change that should not be driven from a chat message and that issue #244 explicitly deferred.

A per-entry "remove the ceremony" decision remains open for entries whose token has no spec override and no cross-module consumer: `CREATE_ORGANIZATION`, `RENAME_ORGANIZATION`, `CREATE_ORGANIZATION_API_KEY`, `LIST_ORGANIZATION_API_KEYS`, `ROTATE_ORGANIZATION_API_KEY`, `REVOKE_ORGANIZATION_API_KEY`, `INVITE_ORGANIZATION_MEMBER`, `ACCEPT_ORGANIZATION_INVITATION`, `LIST_OPEN_ORGANIZATION_INVITATIONS`, `REVOKE_ORGANIZATION_INVITATION`, `READ_ORGANIZATION_AUDIT_EVENTS`, `READ_ORGANIZATION_IDENTITY_CONFIG`, `SET_ORGANIZATION_IDENTITY_CONFIG`, `SANDBOX_ASSERTION_MINTER`, `INTERNAL_TOKEN_ISSUER`, `METERING_FAILURE_LOGGER`, `JWKS_KEY_PROVIDER`, and the four CLI-constructed record ports. Those entries are candidates for a future, per-entry decision; this ADR decides nothing about them except that the default answer is keep.

## Out of scope

- The Organization record ports (`OrganizationCreationRecordPort`, `OrganizationRenameRecordPort`, `OrganizationMembershipPort`, `OrganizationApiKeyPort`, `OrganizationInvitationPort`, `OrganizationStatusPort`, `OrganizationFirstOwnerPort`, `OrganizationIdentityConfigRepositoryPort`): each hides authority decided under the Organization and membership locks plus the audit-event write in one durable act behind a single small method. The seam is the port's documented contract, not the DI token.
- `RuntimeSecretProvider` (`src/modules/secrets`): hides environment/Vault-backed secret resolution behind one call; the variation across environments is real.
- `InternalTokenIssuerPort` (`src/modules/gateway`): hides the signing key material and its rotation behind one call.
- `DownstreamHttpClient` (`src/modules/gateway`): hides HTTP/2, the pool, retry classification, and deadline math behind one call.

These five keep their ports and their ceremony without further measurement.

## Consequences

No code changes. Each future port with a single production binding should record its spec-override story in the port's doc comment; a seam that starts seeing fakes behind its token is no longer hypothetical and does not need this ADR revisited. The count (thirty-five) is a snapshot, not a threshold; new ports join the inventory by adding a row to the evidence table above when they touch #244's scope.
