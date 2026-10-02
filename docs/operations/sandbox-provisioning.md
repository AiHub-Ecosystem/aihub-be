# Sandbox provisioning

How to provision the demo organization used by `POST /v1/sandbox/assertions`, issue and revoke tester keys, and rotate the demo signing key. The mint route itself is described in [`../integration-guide.md`].

## Sandbox data and limits

Organization, API-key, and identity-configuration records live in the
production control-plane database. The Sandbox application reads those records
through the restricted `sandbox_control_plane_read_url` Vault connection.
Sandbox usage, idempotency records, and monthly dispatch reservations live in
`aihub_sandbox`; Redis uses logical database `/1` for sandbox cache and pacing
state.

Customer Sandbox keys are restricted to the `sandbox` environment and the
`writing.grade` scope, which admits Writing Task 1 and Task 2. They use the
customer Organization's own identity configuration and do not call the demo
assertion mint route. Calls reach the real AI Writing service. Each customer
Organization gets at most 25 dispatches per UTC month; the entire Sandbox
environment, including the demo Organization, shares a 500-dispatch monthly
ceiling. The demo Organization's configured quota is an additional limit.
Normal pacing is five requests per minute per key, one in-flight request per
Organization, and ten across Sandbox. These are request-count ceilings, not a
USD cost guarantee.

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

| Setting            | Value | Why                                                                                                                                                        |
| ------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--monthly-quota`  | 500   | A month of ordinary manual testing, well under anything that would matter on an invoice. Raise deliberately, with a reason recorded here.                  |
| `--hard-stop true` | on    | Without it the quota is advisory and traffic continues past the ceiling. A sandbox is exactly where a hard stop belongs: nothing depends on it staying up. |
| `--rate-limit-rpm` | 60    | One request per second is beyond what hand-testing needs and low enough that a runaway script is noticed rather than absorbed.                             |
| `--max-concurrent` | 3     | Speaking grading holds a connection for seconds at a time; three is enough to compare results side by side.                                                |

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

In the deployment's environment file:

```
AIHUB_SANDBOX_ORG_IDS=org_...
AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY=<contents of sandbox-private.pem>
AIHUB_SANDBOX_ASSERTION_KID=<the kid printed in step 1>
```

All three are required. An allowlist without a key would accept a request and then fail to sign it, so the route stays closed until the set is complete. Escaped newlines in the PEM are restored on read, so a single-line value works.

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

To revoke:

```bash
pnpm cli key:revoke --key ak_... --actor <your-username>
```

Revocation is recorded in the Organization Audit Trail the same way, and repeating it records nothing more. This also purges the Redis cache entry, so revocation is immediate rather than waiting out the 60-second identity cache.

## 6. Rotating the sandbox signing key

Sandbox rotation is self-contained: it touches no production signing material and needs no coordination with the AI services, which never see these tokens.

1. Generate a new pair (step 1) with a new `kid`.
2. Write a key set containing **both** the old and new public keys, and `identity:set` it.
3. Switch `AIHUB_SANDBOX_ASSERTION_KID` and `AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY` to the new pair, and restart.
4. Wait out the assertion lifetime configured in step 3 so tokens signed with the old key have expired.
5. `identity:set` again with only the new public key.

Between steps 2 and 5 the key set holds two keys. Every assertion must then carry a `kid` in its header, because key selection requires exactly one match and two candidates without a `kid` resolve to none. The mint endpoint always sets one; a hand-rolled signer must too.

If the private key is believed to be exposed, do steps 1–3 immediately and step 5 straight after, accepting that assertions minted in the last hour stop working. Nothing outside the sandbox is affected.
