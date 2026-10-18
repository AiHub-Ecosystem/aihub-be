# Sandbox provisioning

How to provision the demo organization used by `POST /v1/sandbox/assertions`, issue and revoke tester keys, and rotate the demo signing key. The mint route itself is described in [`../integration-guide.md`].

## Sandbox data and limits

Organization, API-key, and identity-configuration records live in the
production control-plane database. The Sandbox application reads those records
through the restricted `sandbox_control_plane_read_url` Vault connection.
Sandbox allowance policy, usage, idempotency records, and monthly dispatch
reservations live in the Sandbox runtime database `aihub_sandbox`; Redis uses
logical database `/1` for sandbox cache and pacing state.

Customer keys created through the customer-facing key-creation path are bound to
one public environment (Sandbox or Production) and issued under that
environment's display prefix (`aihub_sandbox_` or `aihub_prod_`). Keys issued
before this rule keep the shared
`aihub_sk_` prefix and remain valid in every environment their stored
`allowed_environments` lists; the prefix is a recognition aid and never
authorizes anything. A Sandbox key may carry only `writing.grade`,
`speaking.grade`, or both. The public Writing and Speaking demos accept a key
only when it carries the selected skill's scope, its stored environment matches
the page's selection, and the Organization has no active Identity
Configuration. These live demo requests use the customer's Organization and its
normal Sandbox allowance, not the AIHUB demo Organization's key. The
key-validation call does not dispatch a grade and reserves nothing; each grading
request authenticates the key again. This boundary is recorded in
[ADR-0094](../adr/0094-sandbox-demo-key-admission.md) and
[ADR-0095](../adr/0095-demo-environments-and-sandbox-allowance-policy.md).

Each customer Organization gets at most 5 dispatches per UTC month from the
persisted default; the entire Sandbox environment shares a 500-dispatch monthly
ceiling. Every key, client, and Writing/Speaking skill for one Organization
draws from the same allowance. Normal pacing is five requests per minute per
key, one in-flight request per Organization, and ten across Sandbox. These are
request-count ceilings, not a USD cost guarantee.

## Sandbox dispatch allowance

The allowance is durable policy in the Sandbox runtime database, not code. Run
these SQL examples against `aihub_sandbox` (the sandbox `DATABASE_URL`), not the
production control-plane database:

| Table                         | Holds                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `sandbox_allowance_defaults`  | The default allowance per UTC month. The effective default for a month is the **latest row at or before it**. |
| `sandbox_allowance_overrides` | One Organization's **total** allowance for one specific UTC month, replacing the default for that month.      |

Migration `0037_sandbox_allowance_policy` derives two rows from the moment it
runs: the current UTC month at `25` (the allowance already in effect) and the
next UTC month at `5`. That is what makes the new default of five begin in the
month after deployment while the deployment month keeps what it had. An
allowance an operator already set for either month is left alone. Consumption
lives in `sandbox_dispatch_reservations` and is never touched by these tables,
so deployment and restart preserve it.

The migration cannot see an Organization's own configured
`monthly_request_quota`, which lives in the production control-plane database.
The AIHUB demo Organization used to be capped by that quota (or, with none, only
by the shared ceiling of 500); the durable policy now applies the same default
to every Organization. The migration and the new application version arrive in
one release, and the policy is read on every request, so an override inserted
**right after the migration step** takes effect with no restart. Until it
exists the demo Organization is held to the 25 default, which fails
conservative: it never admits more than before. Read the quota from the
control-plane database. The effective allowance it had is the lower of that
quota and the shared ceiling of 500 (a `NULL` quota means 500), so use that
value as the override:

```sql
-- production control-plane database
SELECT id, monthly_request_quota FROM organizations WHERE id = 'org_...';
```

```sql
BEGIN;
SELECT pg_advisory_xact_lock(
  182,
  extract(year FROM (now() AT TIME ZONE 'UTC'))::integer * 100
    + extract(month FROM (now() AT TIME ZONE 'UTC'))::integer
);

INSERT INTO sandbox_allowance_overrides (organization_id, month_start, allowance)
VALUES ('org_...',
        date_trunc('month', now() AT TIME ZONE 'UTC')::date,
        500) -- LEAST(quota read above, 500); 500 when the quota is NULL
ON CONFLICT (organization_id, month_start) DO UPDATE SET allowance = EXCLUDED.allowance;
COMMIT;
```

**Change the persisted default.** Insert a row for the month you want to change:

```sql
BEGIN;
SELECT pg_advisory_xact_lock(
  182,
  extract(year FROM DATE '2026-12-01')::integer * 100
    + extract(month FROM DATE '2026-12-01')::integer
);

INSERT INTO sandbox_allowance_defaults (month_start, allowance)
VALUES (DATE '2026-12-01', 5)
ON CONFLICT (month_start) DO UPDATE SET allowance = EXCLUDED.allowance;
COMMIT;
```

**Set a month-specific Organization override.** It replaces the default for that
month, does not reset consumption, and expires with the month:

```sql
BEGIN;
SELECT pg_advisory_xact_lock(
  182,
  extract(year FROM DATE '2026-11-01')::integer * 100
    + extract(month FROM DATE '2026-11-01')::integer
);

INSERT INTO sandbox_allowance_overrides (organization_id, month_start, allowance)
VALUES ('org_...', DATE '2026-11-01', 50)
ON CONFLICT (organization_id, month_start) DO UPDATE SET allowance = EXCLUDED.allowance;
COMMIT;
```

**Verify the effective month and allowance.** Every month boundary is UTC; there
is no local-time input anywhere in this path.

```sql
SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date AS effective_month,
       (SELECT allowance FROM sandbox_allowance_defaults d
         WHERE d.month_start <= date_trunc('month', now() AT TIME ZONE 'UTC')::date
         ORDER BY d.month_start DESC LIMIT 1) AS default_allowance,
       (SELECT allowance FROM sandbox_allowance_overrides o
         WHERE o.organization_id = 'org_...' AND o.month_start = date_trunc('month', now() AT TIME ZONE 'UTC')::date)
         AS organization_override;

SELECT status, count(*)
  FROM sandbox_dispatch_reservations
 WHERE organization_id = 'org_...' AND month_start = date_trunc('month', now() AT TIME ZONE 'UTC')::date
 GROUP BY status;
```

Raising an allowance admits only the remaining difference. Lowering one below
what is already consumed blocks further dispatches until the next effective
allowance permits them. If either table cannot be read, grading fails closed
with no dispatch and no permissive default is substituted.

The demo mint route stays restricted to the Organization IDs configured in
`AIHUB_SANDBOX_ORG_IDS`. Until its Organization, identity configuration, and
signing material exist, that route answers `404` and the rest of the gateway is
unaffected.

Provision Organization, API-key, and identity-configuration records through
the production control plane. Set `CONTROL_PLANE_DATABASE_URL` to the
production database for the `pnpm cli org:create`, `identity:set`,
`key:create`, and `key:revoke` commands below. Usage and quota tools continue
to use `DATABASE_URL`, which should point to `aihub_sandbox` for sandbox usage.
The CLI can run from a workstation through the SSH tunnel described in
[`deploy-vps.md`](deploy-vps.md). Sandbox authentication reads the key record
directly on each request, so revocation and suspension apply on the next
request.

For example, expose the production database through the local SSH tunnel and
set the control-plane URL in the workstation shell before running the
Organization, identity, or key commands:

```sh
ssh -N -L 15433:127.0.0.1:5433 <user>@<vps>
export CONTROL_PLANE_DATABASE_URL='postgresql://<user>:<password>@127.0.0.1:15433/aihub'
```

## Environment and organization boundaries

Sandbox runs as its own `sandbox` environment and hostname. Configure
`AIHUB_SANDBOX_HOST` before testing. A key is bound to its Organization and
allowed environment; the hostname check adds a second boundary at ingress.

## 1. Generate the signing key pair

Run this on a workstation, not on the server. Only the public half leaves it.

```bash
node -e '
import("jose").then(async ({ generateKeyPair, exportJWK, exportPKCS8 }) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = "sandbox-" + new Date().toISOString().slice(0, 7);
  require("fs").writeFileSync("sandbox-private.pem", await exportPKCS8(privateKey));
  require("fs").writeFileSync(
    "sandbox-jwks.json",
    JSON.stringify({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }, null, 2),
  );
  console.log("kid:", kid);
});'
```

`sandbox-private.pem` becomes `AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY` in the gateway's environment and goes nowhere else. It is not distributed to testers — the whole point of the mint endpoint is that nobody needs to hold it.

## 2. Create the organization

```bash
pnpm cli org:create \
  --name "AIHUB Sandbox" \
  --entitlements writing,speaking \
  --rate-limit-rpm 60 \
  --max-concurrent 3 \
  --monthly-quota 500 \
  --hard-stop true
```

Prints the new `org_...` id. Keep it; the remaining steps need it.

Quota, rate limit, and concurrency live on the **organization**, not on individual keys. That is what makes per-person keys safe to hand out: they share one budget, so ten testers cannot multiply the spend by ten.

| Setting            | Value | Why                                                                                                                                                                                                                                                                                                                |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--monthly-quota`  | 500   | A month of ordinary manual testing, well under anything that would matter on an invoice. Raise deliberately, with a reason recorded here.                                                                                                                                                                          |
| `--hard-stop true` | on    | The quota refuses requests past the ceiling either way. The hard stop decides what happens when the quota counter cannot be read: on, requests are refused; off, they pass and are recorded as `quota_unverified` (ADR-0018). A sandbox is exactly where failing closed belongs: nothing depends on it staying up. |
| `--rate-limit-rpm` | 60    | One request per second is beyond what hand-testing needs and low enough that a runaway script is noticed rather than absorbed.                                                                                                                                                                                     |
| `--max-concurrent` | 3     | Speaking grading holds a connection for seconds at a time; three is enough to compare results side by side.                                                                                                                                                                                                        |

`--entitlements` must list every service testers need. A scope on a key is filtered by the organization's entitlements, so `speaking.grade` on a key of an organization without the `speaking` entitlement does nothing.

## 3. Register the public key

```bash
pnpm cli identity:set \
  --org org_... \
  --issuer https://sandbox.aihubproduction.com \
  --public-keys-file ./sandbox-jwks.json \
  --allowed-algorithms RS256 \
  --max-assertion-ttl-seconds 3600
```

The issuer is a URL, not a fetched endpoint: registering the key set inline means AIHUB never makes an outbound JWKS request for this organization, so the sandbox stays off that path entirely. The URL still has to be unique across organizations and stable, because it is what binds a minted token to this organization.

`--max-assertion-ttl-seconds 3600` is the maximum the CLI accepts. It applies to this organization alone; production tenants keep their own, lower value. A tester gets an hour per token instead of five minutes, with no code change.

**`identity:set` replaces the whole key set.** To add a second signing key later, write a file containing _both_ keys and pass that. Passing a file with only the new key silently retires the old one, and every assertion signed with it stops verifying.

## 4. Configure the gateway

Configure the dedicated demo organization allowlist on the Sandbox app only;
the production Compose file supplies it to `app-sandbox` and its standby slot.
The private signing key and key id are under `sandbox-assertion` in the
runtime connection file rendered by the shared Vault Agent.

**Current state (2026-10-18): Sandbox and Production share runtime secrets.**
Both tiers mount the same rendered directory, and the Production policy can
read the `sandbox-assertion` path. The isolated Sandbox Agent, AppRole, and
directory (ADR-0105) were reverted in `57afc075` until #351 provisions the
Sandbox Vault tier. Until then, treat anything the Sandbox runtime can read as
reachable from Production, and the reverse. Once #351 lands, the target is the
one described in [the Vault cutover runbook](deploy-vps.md#cut-over-sandbox-to-its-isolated-agent):
a Sandbox-only file rendered by `vault-agent-sandbox`, which the Production
policy cannot read.

The allowlist and signing bundle are both required. An allowlist without a key
would accept a request and then fail to sign it, so the route stays closed until
the set is complete. The mint route is available only through the Sandbox host
on a Sandbox runtime, and the API key is capped at 5 requests per minute.

For the audience cutover, keep the demo API key Sandbox-only. Deploy the new
Sandbox code and drain old Sandbox instances before serving mint or grading
traffic; old verifiers accept only the `aihub` audience and fail closed on the
new `aihub:sandbox` audience. After the last old Sandbox instance stops, wait
61 minutes (the 1-hour assertion lifetime plus 60 seconds of verifier clock
skew) before deploying the new verifier to Production. That lets legacy
Sandbox assertions using `aihub` expire before the Production verifier relies
on the audience boundary while continuing to accept customer assertions.

Restart, then confirm:

```bash
curl -sS -X POST https://<sandbox host>/v1/sandbox/assertions \
  -H "X-API-Key: $SANDBOX_KEY" -H 'Content-Type: application/json' \
  -d '{"user_id":"student_456"}'
```

## 5. Issue a key per person

```bash
pnpm cli key:create \
  --org org_... \
  --actor <your-username> \
  --name "Minh — manual testing" \
  --scopes speaking.grade,writing.grade \
  --envs sandbox
```

`--actor` is the username of your own active AIHUB User Account. The issuance is recorded in the Organization Audit Trail with you as the actor, and the command refuses, exit code 2, an actor that is not an active account. The raw key is printed **once** and never stored. Send it to that person directly, not to a group channel.

One key per person, named after them. A shared key cannot be revoked without disrupting everyone, and the `apiKeyId` in the mint audit line and in `usage_records` is only useful if it identifies someone.

For a public demo key, use only `writing.grade`, `speaking.grade`, or both;
keep `--envs sandbox`, and provide the key directly to its holder.
The key is issued as `aihub_sandbox_…` because it is bound to one environment.
`/demo/scoring` requires `writing.grade`; `/demo/speaking` requires
`speaking.grade`. The demo refuses Organizations with active Identity
Configuration because it cannot collect an assertion signed by that
Organization. `--envs` takes exactly one environment: the command refuses a
list, because every newly issued key is bound to one environment. Only keys
issued before ADR-0095 keep the shared `aihub_sk_` prefix.

To revoke:

```bash
pnpm cli key:revoke --key ak_... --actor <your-username>
```

Revocation is recorded in the Organization Audit Trail the same way, and repeating it records nothing more. This also purges the Redis cache entry, so revocation is immediate rather than waiting out the 60-second identity cache.

## 6. Rotating the sandbox signing key

Sandbox rotation is self-contained: it touches no production signing material and needs no coordination with the AI services, which never see these tokens.

1. Generate a new pair (step 1) with a new `kid`.
2. Write a key set containing **both** the old and new public keys, and `identity:set` it.
3. Switch the Sandbox Vault Agent `sandbox-assertion` bundle to the new key and
   id, and restart the Sandbox app.
4. Wait out the assertion lifetime configured in step 3 so tokens signed with the old key have expired.
5. `identity:set` again with only the new public key.

Between steps 2 and 5 the key set holds two keys. Every assertion must then carry a `kid` in its header, because key selection requires exactly one match and two candidates without a `kid` resolve to none. The mint endpoint always sets one; a hand-rolled signer must too.

If the private key is believed to be exposed, do steps 1–3 immediately and step 5 straight after, accepting that assertions minted in the last hour stop working. Nothing outside the sandbox is affected.
