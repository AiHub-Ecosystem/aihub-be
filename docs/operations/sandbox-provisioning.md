# Sandbox provisioning

How to stand up the organization that `POST /v1/sandbox/assertions` mints for, issue and revoke tester keys, and rotate the sandbox signing key.

The mint endpoint itself is described in [`../integration-guide.md`]. This document covers only the control-plane objects it needs. Until they exist, the route answers `404` and the rest of the gateway is unaffected.

> **Environment.** Sandbox runs as its own `sandbox` environment on its own hostname; #47 adds it. Until that lands there is no valid environment to scope a tester key to, so do not provision yet — the `--envs` value in step 5 changes with it.
>
> This is a boundary of clarity and defence in depth, not the thing that confines a sandbox key. A key is confined by the organization it belongs to: it can only ever act as that organization, its scopes are filtered through that organization's entitlements, and its spend is bounded by that organization's limits. That holds on any hostname. The hostname binding adds a second layer that catches a credential used in the wrong place, and unlike the first it depends on the reverse proxy passing a truthful `Host` — so it is worth having and not worth relying on alone.

## What the isolation does and does not cover

Worth being clear before choosing the numbers below.

A minted assertion carries the sandbox organization's issuer, and `UserAssertionVerifier` compares `iss` against the config of the organization resolved from the API key. So a sandbox assertion is accepted by the sandbox organization and by nothing else, even if the mint endpoint were completely compromised. Identity is contained by design.

What is **not** contained is spend. Sandbox requests reach the same AI Writing and AI Speaking services as production traffic and cost the same money.

Be precise about what currently bounds that, because the limits below are not all equal. `--rate-limit-rpm` and `--max-concurrent` are enforced on every request. `--monthly-quota` and `--hard-stop` are **stored but not yet read by anything** — #51 adds the enforcement. Until it lands, a sandbox organization has a burst ceiling and no spending ceiling, so treat the quota as a value recorded for later rather than a control in force.

`usage_records` rows from sandbox traffic currently land in the same table as everything else and are distinguished by the `environment` column. #50 moves sandbox to its own database, after which the production usage table holds no sandbox rows at all.

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
  --name "Minh — manual testing" \
  --scopes speaking.grade,writing.grade \
  --envs staging
```

The raw key is printed **once** and never stored. Send it to that person directly, not to a group channel.

One key per person, named after them. A shared key cannot be revoked without disrupting everyone, and the `apiKeyId` in the mint audit line and in `usage_records` is only useful if it identifies someone.

To revoke:

```bash
pnpm cli key:revoke --key ak_...
```

This also purges the Redis cache entry, so revocation is immediate rather than waiting out the 60-second identity cache.

## 6. Rotating the sandbox signing key

Sandbox rotation is self-contained: it touches no production signing material and needs no coordination with the AI services, which never see these tokens.

1. Generate a new pair (step 1) with a new `kid`.
2. Write a key set containing **both** the old and new public keys, and `identity:set` it.
3. Switch `AIHUB_SANDBOX_ASSERTION_KID` and `AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY` to the new pair, and restart.
4. Wait out the assertion lifetime configured in step 3 so tokens signed with the old key have expired.
5. `identity:set` again with only the new public key.

Between steps 2 and 5 the key set holds two keys. Every assertion must then carry a `kid` in its header, because key selection requires exactly one match and two candidates without a `kid` resolve to none. The mint endpoint always sets one; a hand-rolled signer must too.

If the private key is believed to be exposed, do steps 1–3 immediately and step 5 straight after, accepting that assertions minted in the last hour stop working. Nothing outside the sandbox is affected.
