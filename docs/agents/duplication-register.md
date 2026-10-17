# Duplication register

Living register of duplicated logic found across the four module trees
(`src/modules`, `src/common`, `src/catalog`, `src/downstream`) on 2026-10-16.
Each row is a starting point to confirm, not a finding already proven.

**Maintenance rules** (from #726):

- A row is closed only when the copies are gone or the reason it stays separate
  is written, never by deleting the row.
- New duplication found later is added here rather than becoming its own
  top-level issue.
- Entries already solved are struck with a pointer to the commit that solved
  them.

The five drifted rules that could change behaviour today are filed on their own
and are **not** repeated here:

- #721 — an Organization-scoped input whose context names another Organization
- #722 — every rate-limited refusal answers the same `Retry-After` header, or none does
- #723 — the Argon2id work factor the code, the dummy hash, and the database constraint agree on
- #724 — whether a stored count is usable
- #725 — the AES-256-GCM envelope, its keyring rule, and its failure kinds

Also already filed, do not duplicate: #678 upload error builders and the S3
not-found check, #705 an Organization-scoped query that omits its predicate,
#403 gateway retry hints, #326 the outbox decision, #503 the JWKS URL rule.

## Status legend

- **open** — copies still present, owner not yet assigned
- **owner: `<path>`** — consolidated under that owner
- **stays separate: `<reason>`** — deliberately duplicated, reason recorded
- **solved in `<commit>`** — struck; the copies are gone

---

## Billing and usage evidence

| #   | Site                                                                                                                                                                                                                                                                            | Status                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | "Billable request" is four SQL expressions in two shapes (`SUM(billable_requests)` in the usage and reconciliation repositories, `COUNT(... billable_requests = 1)` in the completeness report and the billing statement). They agree only while the column is strictly 0 or 1. | open — owner TBD: a single SQL view or a shared predicate in the metering repository                                                                            |
| B2  | The `::bigint` count decode is implemented three times and disagrees: two copies accept a decimal string only when it matches a digit pattern, one accepts any string.                                                                                                          | open — owner TBD: one decode helper in `src/modules/metering`                                                                                                   |
| B3  | Trimmed non-empty text with a length cap is three copies with three different caps (128, 256, 500), with no shared statement of which cap applies to which field.                                                                                                               | stays separate: the caps are domain policy per field; the duplication is the trim-and-check shape, which could share a helper, but the numbers are not one rule |
| B4  | The metering finalizer input is assembled field by field from request evidence in two places, the response path and the background-completion path. A new evidence field reaches one and not the other.                                                                         | open — owner TBD: one assembler in the finalizer                                                                                                                |
| B5  | "Which downstream reports usage" is a map in the finalizer and a hardcoded allowlist in the completeness report, so adding a usage-reporting downstream makes the report reject its own output.                                                                                 | open — owner TBD: one source of truth for usage-reporting downstreams                                                                                           |

## Identity

| #   | Site                                                                                                                                                                                                  | Status                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| I1  | The JWKS URL safety predicate is implemented three times, with five construction sites for two error codes.                                                                                           | open — owner TBD: one predicate in the organization-identity-configuration domain |
| I2  | JWKS key usability (`alg`/`use`/`key_ops`) is stated in the domain and again in the assertion verifier; the verifier does not check that every `key_ops` entry is a string.                           | open — owner TBD: the domain rule; the verifier should call it                    |
| I3  | Entitlement as the leading segment of a scope is derived at issuance and again at authentication, with different empty-case handling.                                                                 | open — owner TBD                                                                  |
| I4  | `dateValue` row reading is six copies with four behaviours (`null` vs `undefined`, one refuses a `Date`, one returns the caller's object).                                                            | open — owner TBD: one reader in the shared identity infrastructure                |
| I5  | Three repositories re-declare `identityStoreError`, `isRecord`, `stringValue`, `stringArrayValue` that already exist beside them.                                                                     | open — owner TBD: import from the shared helpers                                  |
| I6  | "Active membership in an active Organization" is enforced inside the manager check and then restated by three callers.                                                                                | open — owner TBD: one authorization helper                                        |
| I7  | The `X-User-Identity` header chain (required, non-blank, resolved against the caller's tenant) exists in two guards that differ on whether the resolved Organization is re-checked.                   | open — owner TBD                                                                  |
| I8  | The API-key record projection to its published view is written twice and the response mapping three times.                                                                                            | open — owner TBD: one mapper                                                      |
| I9  | `INVITE_ROLES` is restated in the email poller, so a fourth role makes a valid invitation payload be cancelled unsent.                                                                                | open — owner TBD: import from the invitations module                              |
| I10 | The Sandbox per-key rate clamp is the literal 5 in two guards.                                                                                                                                        | open — owner TBD: one constant                                                    |
| I11 | `postgres-api-key.repository.ts` and `redis-identity.store.ts` share 41 lines of row readers (`positiveIntegerValue`, `quotaValue`, `statusValue`, `dateValue`); I4 counts only the `dateValue` part. | open — owner TBD: the shared identity row readers                                 |

## Auth

| #   | Site                                                                                                                                                                                      | Status           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| A1  | The 30-day session lifetime is written three times: refresh token TTL, web-session policy, cookie max age.                                                                                | open — owner TBD |
| A2  | `CUSTOMER_WEB_BASE_URL` is validated twice with different rules (raw string vs parsed), and the sender builds its link from a value the configuration schema never validated.             | open — owner TBD |
| A3  | Which email payload kinds carry a credential is stated three times in the poller.                                                                                                         | open — owner TBD |
| A4  | Auth error constructors are restated per file; the verification-token error exists as both a helper and a literal.                                                                        | open — owner TBD |
| A5  | The MFA re-authentication block (a fresh password must belong to the account whose factor changes) is written twice in one class.                                                         | open — owner TBD |
| A6  | The email outbox row is constructed in two places.                                                                                                                                        | open — owner TBD |
| A7  | The rule "this route does not read credentials from that transport" has three different implementations, so one credential-bearing cookie is refused by one route and ignored by another. | open — owner TBD |

## Media, storage and shared trees

| #   | Site                                                                                                                                                                                       | Status                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | `SPEAKING_AUDIO_MAX_BYTES` is declared twice inside the speaking feature, in the domain and in the multipart parser.                                                                       | open — owner TBD                                                                                                                                                     |
| M2  | Size limits are copied as literals into the boundary contracts instead of imported, so the published schema and the enforcing service can disagree.                                        | open — owner TBD                                                                                                                                                     |
| M3  | `invalidStoredObject` is implemented three times (speaking, writing, avatar) with different minimums and integer checks.                                                                   | open — owner TBD                                                                                                                                                     |
| M4  | The keyset pagination predicate and the sweep batch loop are duplicated between the speaking and writing sweeps.                                                                           | open — owner TBD                                                                                                                                                     |
| M5  | The CLI's SeaweedFS client and secret provider composition is copied three times, four lines each.                                                                                         | open — owner TBD                                                                                                                                                     |
| M6  | The secrets loaders duplicate their parsing helpers and their error text, byte for byte.                                                                                                   | open — owner TBD                                                                                                                                                     |
| M7  | The `contractViolation` error is built in both downstream response adapters, and only the speaking one carries the sanitized diagnostic.                                                   | open — owner TBD                                                                                                                                                     |
| M8  | `GradingRequestMetadata` is assembled in both grading controllers, and the upload deadline of 10 seconds is a literal in both upload controllers.                                          | open — owner TBD                                                                                                                                                     |
| M9  | The writing module holds two promise-chain serialization helpers that mean different things: one serializes globally, one per asset with cleanup.                                          | stays separate: the two helpers have different scopes (global vs per-asset) and different cleanup contracts; the duplication is the chain shape, which is incidental |
| M10 | `isRecord` is declared 28 times under `src`. 25 copies exclude arrays; the multipart parser, the multipart source, and the OpenAPI builder accept them, so the same name means two things. | open — owner TBD: one guard in `src/common`, with the array case decided once                                                                                        |
| M11 | `auth-row.ts` and `identity-row.ts` hold the same 17 lines of row helpers, one per module.                                                                                                 | open — owner TBD                                                                                                                                                     |
| M12 | The Redis client is constructed the same way in `redis-gateway.client.ts` and `redis-identity.store.ts` (17 lines); see #642 on isolating it.                                              | open — owner TBD                                                                                                                                                     |
| M13 | `quota-reconcile.ts` and `redis-ttl-audit.ts` compose their clients with the same 17 lines, the CLI pattern M5 already names for SeaweedFS.                                                | open — owner TBD                                                                                                                                                     |

## Struck (already solved)

- #724 (count usability) — solved in `793875ef`
- #722 (Retry-After header) — solved in `cea7a0dc`
- #723 (Argon2id work factor) — solved in `4450ee46` / `c11c8d19`
- #725 (envelope cipher) — solved in `46332e47`
- #720 (quota month parsing) — solved in `d7522968`
- #729 (refusal paths) — solved in `ac655e7f`
- #728 (tenant-isolation absence) — solved in `8b60749a`
- #739 (DB lane empty message) — solved in `e3315e4c`

## Notes

- I11 and M10–M13 were added on 2026-10-17 from a jscpd run over `src`
  (spec, testing, and generated files excluded; at least 8 lines and 70 tokens):
  14 clones, 223 duplicated lines of 43,617, or 0.51%.

- Rows are closed only when the copies are gone or the reason it stays separate
  is written. Rows are never deleted.
- New duplication found later is appended here rather than becoming its own
  top-level issue.
