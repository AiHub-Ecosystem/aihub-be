# Optional User Identity Verification — Design

- Date: 2026-09-26
- Decision record: [ADR-0053](../../adr/0053-optional-user-identity-verification.md) (supersedes ADR-0050)
- Glossary: `CONTEXT.md` — User Identity, Signed User Assertion, Declared User ID, End-User ID, Organization Identity Readiness

## Goal

Let an Organization grade before it has a JWKS. Verification stays mandatory for Organizations that configured it, and becomes absent (not weaker) for those that did not.

## Public contract

One header on user-scoped operations: `X-User-Identity` (replaces `X-User-Assertion`, no alias — no production customers).

| Organization state              | Accepted value                                 | Result                                         |
| ------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| Active identity configuration   | Signed User Assertion (JWT, current G.4 rules) | End-User ID = `sub`                            |
| Active identity configuration   | anything else                                  | `401 INVALID_USER_IDENTITY` (never downgraded) |
| No configuration, or `disabled` | Declared User ID                               | End-User ID = value as sent                    |

End-User ID rule (both forms, including `sub`): 1–256 characters, each in 0x21–0x7E (visible ASCII, no whitespace). Emails pass.

| Situation                                                         | Response                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| User-scoped operation, header missing                             | `401 USER_IDENTITY_REQUIRED`                                       |
| Header not a string, blank, over 32 KB, or End-User ID rule fails | `401 INVALID_USER_IDENTITY`                                        |
| Signed User Assertion fails any G.4 check                         | `401 INVALID_USER_IDENTITY`                                        |
| Configuration store or JWKS fetch fails                           | `503 IDENTITY_PROVIDER_UNAVAILABLE` (never falls back to declared) |

Removed: `IDENTITY_CONFIG_REQUIRED`, `USER_ASSERTION_REQUIRED`, `INVALID_USER_ASSERTION`.

Unchanged: organization-scoped operations without the header; local auth bypass; sandbox Per-request assertions (the sandbox Organization has an active configuration); a present header on an organization-scoped operation is still resolved and must be valid.

## Flow

```
UserIdentityGuard (was UserAssertionGuard)
  header = headers['x-user-identity']
  missing  -> org-scoped: pass | local bypass: unchanged | else 401 USER_IDENTITY_REQUIRED
  present  -> shape check -> resolver.resolve({ value, organizationId })
           -> request.aihubIdentity; setRequestMeteringActor(endUserId)

UserIdentityResolver (application; the guard's port)
  config = configRepo.findActiveByOrganizationId(orgId)   # throw -> 503
  config ? UserAssertionVerifier.verify(value, config)    # existing JWT logic
         : declaredUserId(value)                          # End-User ID rule
```

- Mode is decided only by the saved configuration, never by whether the value looks like a JWT.
- `UserAssertionVerifier` keeps its checks; it receives the loaded config instead of loading it, and its `IDENTITY_CONFIG_REQUIRED` branch is deleted. `validateClaims` applies the End-User ID rule to `sub`.
- No new table: `organization_identity_configs.status = 'active'` is the readiness signal. Disabling it is an audited owner action that returns the Organization to declared mode.
- Writing/Speaking controllers and the Speaking adapter keep reading `aihubIdentity.userId`; only error codes change. Downstream shapes are unchanged.

## Security notes

- A Declared User ID is trusted as far as the API key: tenant isolation is unaffected; intra-Organization impersonation by a key holder is possible and documented.
- The header value is still redacted from logs in both forms (`src/common/security/redact.ts`).
- Emails are PII; stored in `usage_records.actor_id` and forwarded as-is. The integration guide recommends opaque IDs.

## Documentation to update

- `docs/superpowers/specs/2026-09-07-aihub/05-auth-identity.md` G.4 (+ error list in `07-reliability-and-errors.md`)
- `docs/history/aihub-deliverable-1-historical-contract.md`
- `docs/contracts/aihub/ai-speaking-grading-proxy-tsd-v1.md`, `docs/contracts/ai-services/ai-speaking-grading-v1.md` (`user_id` wording)
- `docs/integration-guide.md`, `docs/customer-web-identity-onboarding.md`, `docs/local-demo.md`, `README.md`
- Generated `openapi.json`, `aihub.postman_collection.json`; scripts `demo-bootstrap.mjs`, `speaking-gateway-smoke.sh`, `dev-sign-assertion.mjs`

## Testing

- Resolver unit tests: active config + valid JWT; active config + plain value → 401; no config + valid/invalid declared value; config store failure → 503; JWKS failure never yields declared mode.
- End-User ID rule: email passes; whitespace, non-ASCII, 0 and 257 characters fail; same rule rejects a bad `sub`.
- Guard tests: header renamed, error codes renamed, org-scoped and local-bypass paths unchanged.
- Writing/Speaking controller specs and `test/db/tenant-isolation/identity.spec.ts` updated for the new header; OpenAPI/Postman snapshot specs regenerated.

## Follow-ups (outside this repo)

- Tell the AI Speaking team that `user_id` may be unverified for declared-mode Organizations.
- Customer Web (`AiHub-Frontend`): warn an owner that disabling the identity configuration switches the Organization to declared mode.
