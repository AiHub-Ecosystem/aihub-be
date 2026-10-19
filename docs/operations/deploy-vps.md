# VPS deployment

This is the production baseline for the single-node Compose deployment. It uses
the existing production `aihub-db` and Wispace Redis, and renders downstream
runtime credentials through Vault Agent. When sandbox isolation is enabled,
`app-sandbox` is a second container from the same image. Its usage,
idempotency, and dispatch budgets use `aihub_sandbox` and Redis logical
database `/1`; Organization, API-key, and identity-configuration records stay
in the production control-plane database and are read through a least-privilege
database login.

**Public TLS is terminated by nginx on the host, not by this Compose stack.**
The `app` service binds `127.0.0.1:${AIHUB_APP_PORT}` and `app-sandbox` binds
`127.0.0.1:${AIHUB_SANDBOX_APP_PORT}`; nginx owns ports 80 and 443 and proxies
each hostname to its matching loopback port. See
[The public edge](#the-public-edge) before changing hostnames or certificates.

## Prerequisites

- Docker Engine with the Compose plugin.
- DNS `A/AAAA` for `AIHUB_PRODUCTION_HOST` pointing to this VPS, and an nginx
  server block for it. Ports 80 and 443 are already held by nginx.
- Add DNS and an nginx server block for `AIHUB_SANDBOX_HOST` when it is
  configured. Leave an unused tier blank: a blank tier is absent from the
  application's hostname map, so no `Host` header can select it.
- nginx uses `AIHUB_APP_PORT` (default `3021`) as its upstream.
- An isolated sandbox needs `AIHUB_SANDBOX_ENABLED=true`,
  `AIHUB_SANDBOX_HOST`, `AIHUB_SANDBOX_ORG_IDS`, and
  `AIHUB_SANDBOX_APP_PORT` (default `3022`). It also has its own Vault AppRole,
  Agent, role ID file, and rendered directory. Its runtime policy reads only
  `secret/data/aihub/sandbox/` paths.
- The external Docker network `aihub-production_backend` with subnet
  `172.16.7.0/24` and gateway `172.16.7.1`.
- The existing Docker network `aihub_aihub-network` with a healthy `aihub-db` container.
- A Production Vault AppRole that can read only Production bundles, and a
  separate Sandbox AppRole that can read only Sandbox bundles when Sandbox is
  enabled.
- A Vault operator session that can provision the AIHUB bundles, including the
  existing Wispace Redis credential, without using the runtime identity.
- A CA file trusted by Vault and a role ID file for each Agent. The Agent
  authenticates with its role ID; it does not use a `secret_id`.
- A release image in the registry, or a local Docker build.

Do not reuse the development AppRole or the development rendered snapshot.

## Shared PostgreSQL connection budget (#560)

The production cluster was measured read-only on 2026-10-15 over SSH with
`nproc`, `free -h`, `swapon --show`, and `sudo docker exec aihub-db psql`:
PostgreSQL 16.15; `max_connections = 100`; `superuser_reserved_connections = 3`;
`reserved_connections = 0`; `shared_buffers = 128MB`; `effective_cache_size = 4GB`;
and `work_mem = 4MB`. The host reported 2 vCPUs, 7.7 GiB RAM, no swap, and
3.3 GiB available. Remeasure before changing a pool or cluster setting because
host availability can change.

The same `pg_stat_activity` snapshot contained 8 rows, including the inspection
query: one idle connection to each of `aihub` and `aihub_sandbox`, plus five
background entries without a database. A connection snapshot is not a capacity
budget. The current source configures up to 74 pool connections per application
process when the three roles share a database URL. ADR-0085 permits three
application containers during a blue-green cutover, making 222 the theoretical
source maximum for that overlap. This is configuration math, not observed
usage or an approved target.

AIHUB owner `@lengocanh2005it` accepted 20 connections of
operational/monitoring headroom on 2026-10-15. At the measured settings, this
leaves an aggregate application budget ceiling of 77 connections
(`100 - 3 superuser-reserved - 0 reserved - 20 headroom`) across all four
applications. This is a policy reserve, not a workload measurement. Allocate
each application's share from its measured peak and owner approval; do not split
the 77 equally or assign the unused remainder.

Before changing pool maxima or shared PostgreSQL settings:

1. Record the measurement date, PostgreSQL version, `max_connections`, all
   configured reserved-connection settings, `shared_buffers`,
   `effective_cache_size`, `work_mem`, and host CPU, RAM, swap, and available
   memory. Do not tune the memory settings without workload evidence and written
   approval from the shared-cluster owner.
2. Obtain written, dated budgets from the owner of each of the four applications.
   The AIHUB owner approved 20 connections of operational/monitoring headroom on
   2026-10-15. Record each app owner, amount, and evidence source in
   [#560](https://github.com/AiHub-Ecosystem/aihub-be/issues/560).
   The application budgets plus that headroom must not exceed measured
   `max_connections` after configured reserved slots are removed. Never infer a
   share from an equal split or a connection snapshot.
3. Calculate AIHUB's maximum by summing the pool maxima for every process and
   database URL that reaches this cluster in each supported overlap: three app
   containers; two app containers plus one migration connection; or two app
   containers plus one scheduled CLI connection. Enforce a one-connection pool
   cap in `scripts/cli/cli.mjs`, the Operator CLI clients in
   `src/cli/operator-*.ts` through
   `src/modules/persistence/infrastructure/prisma-client.ts`, and
   `scripts/cli/migrate.mjs`; serial queries alone do not make a larger pool cap
   equal one. Run only one CLI operator command at a time. Deployment suspends
   scheduled jobs and runs migrations before starting the candidate. Do not add
   migration or CLI connections to the three-container case.
4. Set per-process pool maxima from the approved AIHUB allocation and record the
   computed per-tier peaks and measurement date in #560 and [ADR-0103](../adr/0103-budget-postgresql-connections-on-shared-cluster.md).
   Keep #588's numeric admission/general split unset until this budget is approved.
5. Before closing #560, verify that #474's PostgreSQL connection metric is
   deployed and that its alert fires at 80% of measured `max_connections`.
   #456 is closed; #474 remains open pending its monitoring acceptance criteria.

If #298 selects a dedicated PostgreSQL instance for AIHUB, repeat the sizing and
approval against that instance instead of carrying over the shared-cluster
budget.

## Prepare the host

Clone the release into a dedicated directory, then create the secret mounts outside
the repository. The runtime directory must be writable by UID/GID `10001`, because
both Vault Agent and the application run as that non-root identity.

```sh
sudo install -d -o 10001 -g 10001 -m 0700 /srv/aihub/secrets/runtime
sudo install -d -o 10001 -g 10001 -m 0700 /srv/aihub/secrets/runtime-sandbox
sudo install -d -m 0700 /srv/aihub/secrets
sudo install -m 0600 -o 10001 -g 10001 vault-ca.pem /srv/aihub/secrets/vault-ca.pem
sudo install -m 0600 -o 10001 -g 10001 vault-role-id /srv/aihub/secrets/vault-role-id
sudo install -m 0600 -o 10001 -g 10001 vault-role-id-sandbox /srv/aihub/secrets/vault-role-id-sandbox
sudo docker network create --driver bridge --subnet 172.16.7.0/24 --gateway 172.16.7.1 aihub-production_backend
cp .env.production.example .env.production
chmod 600 .env.production
```

Set hostnames, Vault address, file paths, provider URLs, and ordinary storage
configuration in `.env.production`. `AIHUB_RUNTIME_SECRETS_HOST_DIR` points to
the Production rendered directory; `AIHUB_SANDBOX_RUNTIME_SECRETS_HOST_DIR` and
`VAULT_SANDBOX_ROLE_ID_FILE` point to the Sandbox directory and role ID file.
Production and Sandbox each receive their own downstream credentials,
database/Redis URLs, User Access JWT key, SeaweedFS credentials, and MFA/email
encryption keys from their matching Agent. None of those secret values belong
in `.env.production`.

Set `CUSTOMER_WEB_BASE_URL` to the production Customer Web HTTPS URL. Set the
separate `CUSTOMER_WEB_SANDBOX_BASE_URL` only when a sandbox Customer Web is
deployed. Until then, the API-only sandbox may leave it blank and keeps
token-only emails. Both URLs may include a path prefix, but must not include
credentials, a query, or a fragment.

`AIHUB_PRODUCTION_HOST` and `AIHUB_TRUSTED_PROXY_IP` are required. The trusted
proxy value must be the immediate nginx peer address. Set
`AIHUB_TRUSTED_PROXY_IP=172.16.7.1` in `.env.production`. The shared `backend`
network is external so Compose cannot try to replace it while Production,
Sandbox, and Vault Agent are attached; create it once with the subnet and
gateway above. Before any rollout, the blue-green helper checks its actual
subnet and gateway and checks that the runtime value matches. Production and
Sandbox use the same backend gateway. The separate external database network is
not trusted. Staging must set the exact proxy peer for its own deployment. The
app validates this value as an IP literal and has no hard-coded fallback. CI
rejects a runtime value or external network name that differs from the pinned
AIHUB values.

Setting `AIHUB_SANDBOX_ENABLED=true` and the sandbox host/organization allowlist enables
the isolated Compose profile; the connection bundle supplies its database and
Redis URLs. Serving the hostname is a separate nginx change described in
[The public edge](#the-public-edge). Leaving the sandbox flag false keeps the
sandbox host and container absent.

`AIHUB_SELF_SERVE_MONTHLY_REQUEST_QUOTA` sets the monthly request quota, in
requests, that a new Organization starts on when a customer creates one through
`POST /v1/organizations` (ADR-0041). It has no default in Compose: leaving it
blank uses the built-in value of 100. It must be a positive integer — zero and
fractions stop the process at boot rather than starting an Organization that
could not answer a single request, and "no limit" is a quota of NULL set on the
Organization itself. The value applies only to Organizations created after the
restart; an existing Organization keeps the quota already stored on it, and
raising one is an operator SQL or CLI act, not this variable. The full set of
terms is an Organization's own row, so this setting never retrofits existing
tenants.

Point the gateway at the existing production database over the shared Docker
network. Store the URL-encoded production and sandbox URLs, plus the Sandbox
read-only control-plane URL, in the operator-only Vault bundles. Create the
reader role on the production database with only the columns needed for Sandbox
admission and authentication:

```sql
CREATE ROLE aihub_sandbox_reader LOGIN;
GRANT CONNECT ON DATABASE aihub TO aihub_sandbox_reader;
GRANT USAGE ON SCHEMA public TO aihub_sandbox_reader;
GRANT SELECT (id, status, entitlements, rate_limit_rpm, max_concurrent,
              monthly_request_quota, hard_stop_on_quota)
  ON organizations TO aihub_sandbox_reader;
GRANT SELECT (id, organization_id, key_hash, status, scopes,
              allowed_environments, expires_at, last_used_at),
      UPDATE (last_used_at)
  ON api_keys TO aihub_sandbox_reader;
GRANT SELECT (organization_id, issuer, jwks_url, public_keys_jwks,
              allowed_algorithms, max_assertion_ttl_seconds, status,
              jwks_cache_version)
  ON organization_identity_configs TO aihub_sandbox_reader;
```

Set the role password interactively with `\password aihub_sandbox_reader`;
store the production and Sandbox URLs in their respective credential
directories, then provision each directory to its own Vault path:

```json
// production/database.json
{"url":"postgresql://<production-login>:<password>@aihub-db:5432/aihub"}
// sandbox/database.json
{"url":"postgresql://<sandbox-only-login>:<password>@aihub-db:5432/aihub_sandbox","control_plane_read_url":"postgresql://aihub_sandbox_reader:<password>@aihub-db:5432/aihub"}
// production/redis.json
{"url":"redis://<production-user>:<password>@redis.aihubproduction.com:6379/0"}
// sandbox/redis.json
{"url":"redis://<sandbox-only-user>:<password>@redis.aihubproduction.com:6379/1"}
```

The application reads only its tier's URLs from Vault Agent at startup; neither
URL is passed through Compose interpolation. The Sandbox database and Redis
credentials must be valid only for their Sandbox data stores. Redis database
`/1` alone is not an isolation boundary; use an ACL identity limited to
Sandbox keys and commands.

Speaking sample audio is stored in SeaweedFS. Keep `SEAWEEDFS_ENDPOINT_URL`
(`https://s3.wispace.app`), `SEAWEEDFS_BUCKET` (`aihub-speaking-samples`), and
the SeaweedFS credentials in the runtime secret bundle. To create the bucket
and upload the normalized sample set from an operator workstation, use the
repository script without committing credentials:

```powershell
$env:SEAWEEDFS_ACCESS_KEY_ID = '<access-key>'
$env:SEAWEEDFS_SECRET_ACCESS_KEY = '<secret-key>'
node scripts/cli/upload-speaking-audio.mjs --source E:\audios
Remove-Item Env:\SEAWEEDFS_ACCESS_KEY_ID, Env:\SEAWEEDFS_SECRET_ACCESS_KEY
```

User Account Avatars (ADR-0068) live in their own bucket, named by
`SEAWEEDFS_USER_ASSET_BUCKET` (for example `aihub-user-assets`). It has no
default and never falls back to the Speaking sample bucket: while it is unset,
the Avatar routes answer `503 AVATAR_STORAGE_UNAVAILABLE` and nothing else is
affected. Create the bucket with the same SeaweedFS credentials and set the
variable before deploying.

The Sandbox deployment needs its own Avatar bucket, named by
`SEAWEEDFS_SANDBOX_USER_ASSET_BUCKET` (for example
`aihub-sandbox-user-assets`). Production and Sandbox keep their Avatar records
in different databases, so a shared bucket would make each deployment's sweep
treat the other's live Avatars as orphans and delete them. While the variable
is unset, Sandbox Avatar routes answer `503 AVATAR_STORAGE_UNAVAILABLE`, and
Sandbox never falls back to the production bucket. The Sandbox bucket needs the
same anonymous read-only grant as the production one.

Speaking Audio uploads use separate private buckets, `aihub-speaking-recordings`
and `aihub-sandbox-speaking-recordings`, configured through
`SEAWEEDFS_AUDIO_ASSET_BUCKET` and
`SEAWEEDFS_SANDBOX_AUDIO_ASSET_BUCKET`. Both buckets were created on the VPS on
2026-10-04. Anonymous list, read of a temporary probe object, write, and delete
each returned `403` against both local S3 buckets; anonymous bucket listing
through `https://s3.wispace.app` also returned `403` for both. No public policy
was applied.

Set each environment's exact bucket variable when deploying #207. Upload and
cleanup operations fail closed when the selected environment's bucket name or
SeaweedFS credentials are unavailable; they never use the sample or Avatar
buckets.

Avatars are published, not signed (ADR-0069). Each Avatar bucket must allow
anonymous **read of objects only**: no anonymous list, write, or delete. That is
a per-bucket S3 policy set through the S3 API with the existing SeaweedFS
identity; the host's `s3.json` is not touched. Create the bucket and apply the
policy once per bucket (on 2026-10-02 this was done for `aihub-user-assets` and
`aihub-sandbox-user-assets`):

```python
import json, boto3

s3 = boto3.client("s3", endpoint_url="http://127.0.0.1:8333",
                  aws_access_key_id=..., aws_secret_access_key=...)
bucket = "aihub-user-assets"  # and aihub-sandbox-user-assets
s3.create_bucket(Bucket=bucket)
s3.put_bucket_policy(Bucket=bucket, Policy=json.dumps({
    "Version": "2012-10-17",
    "Statement": [{
        "Sid": "PublicReadGetObject", "Effect": "Allow", "Principal": "*",
        "Action": "s3:GetObject", "Resource": f"arn:aws:s3:::{bucket}/*",
    }],
}))
```

Run it on the SeaweedFS host against the local S3 port, with the identity's
credentials read from the host's secret store, never typed into a shell history
or committed. Until a bucket carries the policy, its Avatar images answer `403`
and the Customer Web shows its fallback. Check the grant from a client outside
the AIHUB network, without credentials, against an uploaded probe object that
you delete afterwards:

- `GET https://s3.wispace.app/<bucket>/<an Avatar object key>` answers `200`
  with the image's `Content-Type` and `Cache-Control: public, max-age=3600`;
- `GET https://s3.wispace.app/<bucket>/` (a bucket listing) answers `403`;
- an anonymous `PUT` and `DELETE` of an object answer `403`;
- a Speaking sample object in `aihub-speaking-samples` still answers `403`.

Both Avatar buckets passed every check on 2026-10-02, including the
`Cache-Control` header (ADR-0069). If it is ever missing from the first
response, record that in ADR-0069: the one-hour cache bound then depends on
browser heuristics. An upload must be
completed within one hour; a completion older than that answers `404` and
deletes the object.

### Writing Task 1 chart storage

Create separate Production and Sandbox staging/public buckets:
`aihub-writing-chart-staging`, `aihub-writing-charts`,
`aihub-sandbox-writing-chart-staging`, and `aihub-sandbox-writing-charts`.
Set the matching `SEAWEEDFS_*_CHART_*_BUCKET` values in `.env.production`;
Compose maps Sandbox values into the Sandbox app. Set
`AIHUB_CHART_PUBLIC_BASE_URL` and `AIHUB_SANDBOX_CHART_PUBLIC_BASE_URL` to
`https://s3.wispace.app`. The adapter adds the selected public bucket and object
key to the URL, so Production and Sandbox remain isolated at
`/aihub-writing-charts/` and `/aihub-sandbox-writing-charts/`. Upload creation
fails closed until its selected bucket names and public origin match the
environment.

Keep both staging buckets private. Configure their S3 CORS rules for the exact
deployed Customer Web origins (`CUSTOMER_WEB_BASE_URL` and
`CUSTOMER_WEB_SANDBOX_BASE_URL`), allow `POST` and the `Content-Type` request
header, and do not enable credentials. The public buckets allow anonymous
`GetObject` only: no list, write, or delete. The shared S3 host routes bucket
paths to SeaweedFS; bucket policies keep staging private and restrict anonymous
access to the two public buckets. Keep public writes and deletes under the AIHUB
storage identity.

Before public rollout, verify from outside the host that a published object is
readable at its shared-host bucket URL, an incomplete staging object and bucket
listing return `403`, and anonymous writes and deletes on public buckets return
`403`. Verify a browser `POST` from each configured Customer Web origin
succeeds. Completed objects in either public bucket are intentionally readable
by anyone with the URL; staging remains private. Bucket policies and CORS
settings are deployment gates; source changes do not provision them.

Before enabling public chart rollout, also publish the AIHUB-controlled abuse
report contact selected by the operations/support owner. The contact is a
business value from ADR-0100; do not invent or publish a placeholder. The
response target is one business day for triage and a response to the reporter,
not a promise that public access or every outside copy will be removed in that
time.

### Sweeping Speaking Audio upload orphans

`speaking:audio-upload-sweep` removes rejected uploads and incomplete intents
whose one-hour expiry passed at least 24 hours ago. It deletes only the exact
object key in each intent, then removes that intent. A missing object is an
idempotent success; failed deletion keeps the intent for the next retry.

The managed `speaking-upload-sweep` job runs it daily at 04:20 UTC for each
enabled deployment, with a 30-minute limit per deployment, and logs one summary
line per deployment to `~/aihub-speaking-upload-sweep.log`. To see what a run
would remove without removing anything, run the wrapper's dry run:

```sh
./scripts/ops/host-jobs/host-scheduled-job.sh speaking-upload-sweep --dry-run true
```

Each invocation uses that deployment's database and environment-specific
bucket. It prints one
JSON line containing only `scanned`, `eligible`, `deleted`, `failed`, and
`dryRun`; it never prints an object key or End-User ID. Any failed delete makes
the command exit non-zero so the next scheduled run can retry it.

### Sweeping orphaned Avatar objects

Objects that were uploaded but never completed, or whose immediate delete
failed, are removed by `avatar:sweep`. It lists the Avatar prefix, keeps every
object that an Avatar record names, and deletes the rest once they are older
than **24 hours** by the storage server's own last-modified time. It touches
only keys of the exact form
`users/usr_<ULID>/avatar/ava_<ULID>/original`; any other key is left alone and
counted as unrecognised. The one-hour completion window and the 24-hour grace
leave a 23-hour gap in which an object can neither be completed nor swept, so
the two can never act on the same object. Both are constants in the code, not
settings.

Run it once a day for each deployment, like `usage:prune`, after its bucket
setting exists. **Run it with `--dry-run true` first** and check the summary
before the CD-managed daily schedule runs it:

```sh
./scripts/ops/host-jobs/host-scheduled-job.sh avatar-sweep --dry-run true
```

The wrapper resolves both active services and uses
`scripts/runtime/runtime-entrypoint.mjs` to load the runtime secrets before
dispatching the command. It records each tier's dry-run summary in the Avatar
log.

CD installs the versioned host wrapper and its managed crontab entries after it
has checked the active release. The daily `avatar-sweep` job runs the Avatar
sweep for each enabled deployment at 03:30 UTC. It resolves the active
blue-green services for every run, logs one summary line per command and
deployment, and exits non-zero if any command fails. The installation
preserves unrelated crontab entries; do not edit the AIHUB managed block by
hand. After reviewing the dry-run summaries, run the actual sweep through
`./scripts/ops/host-jobs/host-scheduled-job.sh avatar-sweep`; it enforces a 30-minute
deadline per deployment and the nonblocking same-job lock.

It prints one JSON line of counts (`scanned`, `unrecognised`, `orphaned`,
`deleted`, `failed`, `dryRun`) and never an object key. It exits non-zero when
any delete failed, or when the bucket, the storage credentials, or the
database is not configured, in which case it has deleted nothing. Alert on a
non-zero exit and on a missed run for either container.

### Sweeping Writing Task 1 chart uploads

Before enabling the managed schedule, inspect eligible records with a dry run:

```sh
./scripts/ops/host-jobs/host-scheduled-job.sh chart-upload-sweep --dry-run true
```

The managed job runs every 15 minutes for each enabled deployment. Published
objects become eligible 24 hours after publication; incomplete staging objects
become eligible 24 hours after their one-hour intent expires. Deletion happens
on the first successful sweep after the deadline. The wrapper logs per-tier
counts to `~/aihub-writing-chart-upload-sweep.log`; alert on a non-zero exit or
a missed run. The sweep deletes object bytes before its durable row, so failed
storage deletion remains retryable.

### Responding to reported Writing Task 1 charts

The revocation path was verified in Production and Sandbox on 2026-10-19
under revision `acec82358f38168b08f0740aa45425c7e1549341`.
On 2026-10-19, `ops/status.sh` reported both environments running
revision `92f5d9d5d1e42b921a4c15f51d8d24ef9973ec7e` with healthy containers,
`/health` and `/ready` returning 200, and zero restarts or errors.
Use `ops/status.sh <commit-sha>` to verify the current deployed revision.
Public chart rollout remains subject to the separate provider URL-fetch
security gate in #376.

1. Receive reports through the published AIHUB-controlled contact at
   [lengocanhpyne363@gmail.com](mailto:lengocanhpyne363@gmail.com). Triage and
   respond to the reporter within one business day. Keep the raw report in its
   controlled intake channel; do not copy it or chart bytes into an operator
   command or audit record.
2. Identify the chart from its public URL. Accept only HTTPS URLs on
   `s3.wispace.app` whose path names the Production
   `aihub-writing-charts` or Sandbox `aihub-sandbox-writing-charts` bucket and
   the exact published chart object. Refer URLs outside these AIHUB-controlled
   buckets to the responsible party; AIHUB cannot revoke those objects. Once
   the report is substantiated and the chart is in scope, initiate revocation
   promptly.
3. Run `pnpm cli writing:chart-revoke --url <public-url> --actor <active-operator-username>`
   from that environment's operator host with its operator credentials.
   The credentials authorize execution; `--actor` identifies the active AIHUB
   account for audit and grants no privilege by itself.
4. Read the result as two separate facts: whether the origin object was
   deleted or already absent, and whether the public edge stopped serving it.
   The edge probe checks the public GET path with a bounded one-byte Range
   request and cancels the body after headers arrive. If the edge still returns
   the object, the result is propagation pending; recheck and escalate if it
   remains public beyond the measured bound. The command must work when the
   15-minute expiry sweep has already removed the database row.
5. The per-environment internal audit appends a request event before deletion,
   then a completion event with the result. It records asset ID, operator
   account, timestamp, and phase without the report, URL, or image bytes. If
   the CLI says the outcome is unconfirmed, the request event remains; after
   database recovery, rerun the same URL and actor because deletion is
   idempotent. Events are immutable during the
   24-month retention period and removed only by the managed per-environment
   `usage:prune` job at 02:30 UTC when expired.

#### Public-edge verification record (#816, 2026-10-19)

Each bucket was tested with a synthetic 67-byte PNG. Full public GETs from a
host outside the app VPS returned 200 OK; both responses had Content-Type:
image/png, Content-Length: 67, Connection: keep-alive, Accept-Ranges: bytes,
Cache-Control: public, max-age=300, must-revalidate, and Content-Disposition:
inline. Neither response had Age or Via.

Production at 07:18:45 UTC returned these headers:

    Server: nginx/1.28.3 (Ubuntu)
    Date: Mon, 19 Oct 2026 07:18:45 GMT
    Content-Type: image/png
    Content-Length: 67
    Connection: keep-alive
    Accept-Ranges: bytes
    Cache-Control: public, max-age=300, must-revalidate
    Content-Disposition: inline
    Etag: "17b3e19593efeb4c09a755092de9d245"
    Last-Modified: Mon, 19 Oct 2026 07:18:20 GMT
    Seaweed-X-Amz-ETag: 17b3e19593efeb4c09a755092de9d245
    Seaweed-X-Amz-Owner: wispace
    Vary: Origin
    X-Amz-Request-Id: 18DFDD24836410533F61F59D

Sandbox at 07:04:58 UTC returned these headers:

    Server: nginx/1.28.3 (Ubuntu)
    Date: Mon, 19 Oct 2026 07:04:58 GMT
    Content-Type: image/png
    Content-Length: 67
    Connection: keep-alive
    Accept-Ranges: bytes
    Cache-Control: public, max-age=300, must-revalidate
    Content-Disposition: inline
    Etag: "da5e4f2edeb4158738826d6c56be2cf9"
    Last-Modified: Mon, 19 Oct 2026 07:04:36 GMT
    Seaweed-X-Amz-ETag: da5e4f2edeb4158738826d6c56be2cf9
    Seaweed-X-Amz-Owner: wispace
    Vary: Origin

The environment-specific CLI deleted each object and recorded origin=deleted,
edge=not_serving, and status=404 in its internal audit. Independent public
GETs returned 404 by 07:06:43 UTC for Sandbox (12 seconds after completion)
and 07:19:24 UTC for Production (22 seconds after completion). The Production
URL then remained 404 for 30 checks at 10-second intervals from 07:20:01 to
07:25:08 UTC. The Sandbox URL remained 404 for 29 checks over five minutes
from 07:09:41 to 07:14:45 UTC. No stale 2xx response was observed; the longest
measured time to an independent 404 was 22 seconds after CLI completion.
Escalate if a deleted object still returns 2xx five minutes after origin
deletion. These are observed results for the tested paths, not a guarantee
about copies outside AIHUB's control.

### Scheduled operator jobs

The versioned schedule is [`ops/host-jobs/aihub.crontab`](../../ops/host-jobs/aihub.crontab).
CD stages the installer at a temporary candidate path, suspends the managed
AIHUB crontab block, and waits for already-running current and legacy AIHUB
host jobs to finish (maximum 15 minutes) before syncing shared helpers or
deploying. This prevents a running job from invoking a helper while CD replaces
it, or an old wrapper from running against a newly active image. Unrelated
crontab entries continue to run. After deployment, CD checks the active tier
revisions and only proceeds when every active tier runs the target revision.
It smoke-tests the staged wrapper against every active tier, installs the
wrapper, smokes the installed wrapper, then enables and verifies the managed
schedule.
If a failed rollout leaves every tier on the same previous revision and no
pending recovery state, CD restores the saved crontab. Mixed, unknown, or
pending tier state keeps AIHUB jobs suspended for operator recovery. This
preserves ADR-0085's per-tier rollback behavior: Production can remain on the
new release while Sandbox returns to its previous release, with scheduled
jobs held until the revisions are aligned again.

If deployment-file synchronization fails after the pause, CD restores the
previous Compose file, host deployment helper, and saved crontab before it
exits. If that recovery cannot be confirmed, the saved crontab remains in
`.aihub-host-jobs-state/` for operator recovery.

The installer replaces only the `AIHUB MANAGED JOBS` block, preserves unrelated
entries, and removes old hand-installed AIHUB wrapper lines. Unknown active
revisions or a failed smoke leave AIHUB jobs suspended. A pending recovery
record is preserved and continues to block later deployments; CD can resume
jobs only when the staged wrapper passes against every active tier. The saved
crontab stays in `.aihub-host-jobs-state/`; after following the #289 recovery
procedure, restore it with
`APP_DIR=<deployment-dir> ./scripts/ops/host-jobs/install-host-jobs.sh restore`.
Promotion or crontab verification failures restore the pre-promotion wrapper
and template while keeping the schedule suspended.

The schedule uses the VPS's UTC clock:

- `quota` reconciles at 02:00;
- `prune` runs at 02:30, after reconciliation;
- `report` runs at 5 minutes past each hour for the preceding UTC hour;
- `ttl-audit` runs at 01:45 daily;
- `avatar-sweep` runs `avatar:sweep` at 03:30 daily.
- `chart-upload-sweep` runs `writing:chart-upload-sweep` at 10, 25, 40, and
  55 minutes past each hour.
- `speaking-upload-sweep` runs `speaking:audio-upload-sweep` at 04:20 daily.

`idempotency:cleanup` is the one cleanup command not scheduled yet (#272).
`scripts/ci/cleanup-commands-scheduled.spec.ts` fails when a sweep, prune, or
cleanup command is neither in this schedule nor listed there as manual with a
reason, so a new one cannot be added and forgotten.

To check that a job's last run succeeded, read its newest lines in its log. A
successful run logs one line per enabled deployment with `exit=0` followed by
the command's summary. A `skipped` or `deferred` line (which names no
deployment), a deployment line without `exit=0`, or no line since the
deployment, or no line since the
scheduled time means it did not run to completion.

Prometheus watches the same outcome without anyone reading the log: each
scheduled run records its success or failure for the node exporter, and
`AIHUBScheduledJobFailed` and `AIHUBScheduledJobMissed` alert on a failed run
and on a run that did not succeed in time
([Scheduled jobs](aihub-observability.md#scheduled-jobs), #291).

| Job                                     | Log file                                 |
| --------------------------------------- | ---------------------------------------- |
| `quota`, `prune`, `report`, `ttl-audit` | `~/aihub-ops-job.log`                    |
| `avatar-sweep`                          | `~/aihub-avatar-sweep.log`               |
| `chart-upload-sweep`                    | `~/aihub-writing-chart-upload-sweep.log` |
| `speaking-upload-sweep`                 | `~/aihub-speaking-upload-sweep.log`      |

```sh
grep -E ' prune ' ~/aihub-ops-job.log | tail -n 3
```

No two jobs start in the same minute, and `host-scheduled-job.spec.sh` fails
when a schedule change makes two start together. Two jobs started in the same
minute race for the host lock, and the loser is deferred, not retried: from
2026-10-15 to 2026-10-17 a sweep every 15 minutes made the nightly `prune` lose
on two nights in a row.

Each CLI invocation has a hard deadline per enabled deployment. Production and
Sandbox each get the full limit; a failure or timeout in Production is logged
and does not prevent the Sandbox invocation.

| Job                     | Per-deployment limit |
| ----------------------- | -------------------: |
| `quota`                 |           15 minutes |
| `prune`                 |           30 minutes |
| `report`                |            3 minutes |
| `ttl-audit`             |           15 minutes |
| `avatar-sweep`          |           30 minutes |
| `chart-upload-sweep`    |           30 minutes |
| `speaking-upload-sweep` |           30 minutes |

The wrapper also caps deployment-status lookup at 30 seconds. The in-container
CLI stops at its listed deadline; if Docker exec has not returned 15 seconds
later, the wrapper terminates that client, with a further 5-second kill grace.
It holds a nonblocking per-job `flock` and one host-wide job lock across both
deployments. A second invocation of the same job logs
`skipped reason=already_running` and exits without starting a command. A
different job that finds the host lock held logs
`deferred reason=host_job_active`, exits non-zero, and must be rerun manually;
this policy permits at most one scheduled maintenance job across Production
and Sandbox at a time. Rerun a missed report window with explicit `--from` and
`--to` timestamps. Locks release automatically when the wrapper exits. The VPS
needs `flock` (util-linux) and `timeout` (coreutils).

This bounds concurrent maintenance jobs to one; it does not measure API grading
headroom while a job runs. Record the representative grading-plus-maintenance
latency, Postgres pool wait, CPU, and memory results before treating the
capacity gate in #495 as complete. The repeatable grading benchmark is tracked
in #327.

For every run the wrapper reads the validated blue-green status and invokes the
active service in each enabled deployment. It fails closed on missing,
ambiguous, or unsupported routing; only a Sandbox deployment reported as
disabled is skipped. It detaches stdin, appends one success summary line per
command and tier to the existing operator or Avatar sweep log, and writes at
most the last 50 stderr lines for a failed command. Cron redirects wrapper
output because the wrapper owns its log. A non-zero exit or a missing scheduled
success must alert. Start a scheduled job manually through the same wrapper to
retain its timeout, locks, and per-deployment logging. `report` accepts an
optional explicit window with `report --from <UTC-start> --to <UTC-end>`; without
one, it reports the previous UTC hour. If the wrapper defers a scheduled
report because another job is active, rerun the original hour with explicit
timestamps.

The `redis:ttl-audit` command scans `aihub:*` and exits non-zero if an expiring
key has no TTL. It prints aggregate counts only, never Redis key names. The
persistent `aihub:v1:jwks-generation:*` invalidation fences are counted
separately because they must not expire and make a purged JWKS cache entry
current again. To run the scheduled TTL audit manually, use
`./scripts/ops/host-jobs/host-scheduled-job.sh ttl-audit`; it has a 15-minute limit and
shares the same-job lock. `report` computes `--from` and `--to` as the start of
the previous and current UTC hours, so `to` is never in the future.

The wrappers currently use `docker compose exec` against the active serving
services. Moving jobs into one-shot containers belongs to #433; time limits and
overlap locks belong to #495. Before the first scheduled `prune`, the database
was backed up with `pg_dump -Fc` and the command was run by hand in each
container (`deleted: 0`, nothing was 13 months old).
The Compose file does not create a second Postgres service or volume. Verify the
existing service before starting the gateway:

```sh
docker network inspect "${AIHUB_DATABASE_NETWORK:-aihub_aihub-network}" >/dev/null
docker inspect --format '{{.State.Health.Status}}' aihub-db
```

The production Redis endpoint is `redis.aihubproduction.com:6379`; verify that
the VPS firewall permits the Redis protocol before starting the gateway. Do not
grant the AIHUB runtime AppRole access to the `wispace-bots` path; the operator
copies only the required password into the AIHUB `redis` bundle. Redis `/1` is not a
durable isolation boundary: it keeps sandbox counters/cache keys out of the
production logical database, while Postgres remains the durable boundary.

### Postgres backups

`scripts/ops/backups/backup-postgres.sh` runs from the CD-managed crontab at minute 47
of every hour (#281, spec 10 §N.4). For `aihub` and `aihub_sandbox` it runs
`pg_dump -Fc` inside `aihub-db`, encrypts the dump on the host with `age` to a
public key, and copies it to the Cloudflare R2 bucket with a pinned `rclone`
image. It writes one line per database to `~/aihub-postgres-backup.log` and
exits non-zero when any database fails. It takes its own lock, not the
host-wide job lock, so a long sweep cannot make it skip an hour. It reports to
Prometheus as task `postgres-backup`: a failed run alerts at once, and two
hours and 20 minutes without a success alert as missed
([Scheduled jobs](aihub-observability.md#scheduled-jobs)).

| Bucket prefix   | Written by               | Kept (R2 lifecycle rule) |
| --------------- | ------------------------ | ------------------------ |
| `hourly/<db>/`  | every run                | 2 days (48 dumps)        |
| `daily/<db>/`   | the 00 UTC run           | 30 days                  |
| `monthly/<db>/` | the 00 UTC run on day 01 | 365 days                 |

Retention is enforced by the three lifecycle rules on the bucket, not by the
script. The **RPO is about one hour**.

Host setup, once:

- `~/.aihub-backup.env`, mode `0600`, holds `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (an R2 token limited to Object
  Read & Write on the bucket), `R2_BUCKET`, and `AGE_RECIPIENT` (the public
  key). The script refuses to run with any other file mode.
- The script downloads the `age` release on its first run into
  `~/.aihub-backup-tools/` and refuses it unless the tarball's SHA-256 matches
  the one pinned in the script.

The **age private key never goes on the host**. It lives in the operator's
password manager; without it no backup can be read. Losing it makes every
backup useless, the same failure that cost the shared Vault on 2026-10-18.

#### Restore rehearsal and restore

The rehearsal restores the newest hourly dump into a disposable Postgres
container with no network and compares per-table row counts with the live
database. The private key travels on stdin and is held only in memory:

```sh
ssh <user>@<host> '~/aihub-be/scripts/ops/backups/restore-postgres-rehearsal.sh aihub' \
  < AIHUB-BACKUP-AGE-KEY.txt
```

It appends `result=ok|mismatch`, the table count, the rows each table is behind
the live database (the backup is up to an hour old), and the elapsed seconds
to `~/aihub-postgres-restore-rehearsal.log`. The elapsed time is the measured
restore time for that database. Run it for both databases at least monthly and
after any change to the backup job.

A real restore follows the same steps by hand: download the chosen object with
`rclone`, decrypt it with `age -d -i <key>`, and `pg_restore` it into the target
database during a maintenance window. Restore over a live database only after
taking a fresh dump of it, and run `quota:reconcile` afterwards so Redis
counters match the restored `usage_records`.

## SSH access (#570)

sshd on the production host accepts keys only.
`/etc/ssh/sshd_config.d/10-aihub-hardening.conf` sets these three options:

- `PasswordAuthentication no`
- `KbdInteractiveAuthentication no`
- `PermitRootLogin prohibit-password`

sshd reads that directory in name order and keeps the first value it finds,
so this file overrides `50-cloud-init.conf`, which turns passwords on.

OpenSSH's built-in `PerSourcePenalties` throttles repeated failures. It is on
by default from OpenSSH 9.8. It is part of sshd, so it survives a reboot
without fail2ban.

The deploy user's sudo rules do not cover sshd. Change the file through
Docker, which is root-equivalent, then validate and reload:

```bash
sudo -n docker run -i --rm --privileged --pid=host alpine:3.20 \
  nsenter -t 1 -m -u -n -i -p sh -c 'sshd -t && systemctl reload ssh'
```

Make any change to the sshd configuration in this order:

1. Keep a second SSH session open until a new login has been tested.
2. Arm a revert that runs unless you confirm the change. #570 used
   `systemd-run --on-active=300` to remove the file and reload sshd. It
   stopped that timer once the checks passed.
3. Test a new login with a key.
4. Confirm that
   `ssh -o PreferredAuthentications=none -o PubkeyAuthentication=no <user>@<host>`
   answers `Permission denied (publickey)`.
5. Confirm that `sshd -T` shows the new values.

**If no key works,** sshd cannot get you back in. The way back is the VPS
provider's web console, which does not go through sshd. The AIHUB maintainer
has no provider account: the team behind the `VietHXQ` account rents the VPS
and holds it. Ask them to open the console, remove the drop-in file, and run
`systemctl reload ssh`. Before that is needed, check whether another key
still works: the maintainer account has more than one key, and any account
that can run `sudo -n docker` can remove the file with the command above.

To give someone access, add their public key to `~/.ssh/authorized_keys` of
their account. A new account needs its key before its first login, because
password logins are refused. The first login with a new key raises
`AIHUBSSHNewKeyLogin`; see "SSH logins" in `container-watchdog.md`.

## Provision production Vault data

Use the repository helper with the production operator workflow. It writes the
ten production KV paths and never prints secret values:

```sh
AIHUB_VAULT_PROVISION_ALLOW=true \
AIHUB_VAULT_ENVIRONMENT=production \
AIHUB_VAULT_CREDENTIALS_DIR=/secure/aihub/production \
AIHUB_VAULT_AGENT_CIDR=172.16.2.1/32 \
  node ops/vault/provision-runtime-secrets.mjs
```

The Production directory contains `ai-speaking.json`, `ai-writing.json`,
`resend.json`, `user-access-jwt.json`, `seaweedfs.json`, `database.json`,
`redis.json`, `email-outbox.json`, `web-session.json`, and `auth-mfa.json`. It
must not contain `sandbox-assertion.json`. Keep the directory mode `0700` and
remove it after installing the helper-generated `vault-role-id` at
`VAULT_ROLE_ID_FILE`. The required flat bundle shapes, including the
`client_secret` string in `web-session.json`, are documented in
[Vault bootstrap](../../ops/vault/README.md#policy-bootstrap).

`AIHUB_VAULT_AGENT_CIDR` is the address Vault records as the login source, not
the Agent container's IP. The Agent and Vault run on separate Docker networks,
so Docker NATs the connection to the Vault-side gateway first: on this host the
Agent is at `172.16.7.x` but Vault sees `172.16.2.1`. Read the value from a
rejected login in the Vault audit log.

The role is provisioned with `bind_secret_id=false` so the Agent authenticates
with its role ID alone and can re-authenticate whenever it is restarted, and
with `bound_cidr_list` as the constraint Vault requires in that mode. Because
every container on the host is NATed to the same gateway, that constraint blocks
logins from outside the VPS but does not distinguish containers on it; the
runtime policy is what limits what the token can read.

Provisioning requires a non-root operator identity. The Agent needs no
`secret_id`; for smoke checks, authenticate the Vault CLI as the generated
AppRole using its role ID and keep the returned token only in the shell
environment. Never print it or run the smoke check with the operator or root
token. Validate the policy before starting the application:

```sh
AIHUB_VAULT_SMOKE_ALLOW=true \
AIHUB_VAULT_SMOKE_AUTH_METHOD=approle \
AIHUB_VAULT_ENVIRONMENT=production \
  node scripts/ops/vault/vault-smoke.mjs
```

Run the smoke command from a Vault CLI session authenticated as the generated
non-root AppRole, not as the provisioning operator or a root token. The
Sandbox AppRole smoke check additionally verifies that every Production path
is denied.

## Provision Sandbox Vault data

> **Not in effect yet (2026-10-18).** This section and the cutover below describe
> the Sandbox isolation of ADR-0105, which was reverted in `57afc075` because the
> rebuilt Vault has no Sandbox tier. Until #351 is provisioned and the revert is
> undone, Sandbox and Production share one Vault Agent, one rendered directory,
> and one set of runtime credentials. The Production policy includes the
> `sandbox-assertion` path. Do not treat the statements below as the current
> state.

Use a separate credentials directory containing independent Sandbox values for
all runtime bundles. The database and Redis bundles contain only Sandbox
credentials; the `database.json` control-plane reader remains restricted to
the authentication columns and `api_keys.last_used_at`. Create a Sandbox
SeaweedFS identity restricted to Sandbox buckets and separate User Access JWT,
email-outbox, web-session, and MFA keys. Use a separate Resend API key if the
provider allows one. Never copy a Production provider or storage credential to
the Sandbox directory.

Provision the Sandbox policy, AppRole, and eleven bundles with a non-root
operator session:

```sh
AIHUB_VAULT_PROVISION_ALLOW=true \
AIHUB_VAULT_ENVIRONMENT=sandbox \
AIHUB_VAULT_CREDENTIALS_DIR=/secure/aihub/sandbox \
AIHUB_VAULT_AGENT_CIDR=172.16.2.1/32 \
  node ops/vault/provision-runtime-secrets.mjs
```

The helper saves the role ID as `vault-role-id` in that private directory.
Install it at `VAULT_SANDBOX_ROLE_ID_FILE` with owner `10001:10001` and mode
`0600`; create `AIHUB_SANDBOX_RUNTIME_SECRETS_HOST_DIR` with the same owner and
mode `0700`. Run `pnpm vault:smoke` as the Sandbox AppRole; it checks every
Production secret path is denied without printing secret contents. Provision
the Production directory with only Production `database.json` and `redis.json`
fields; the Production policy has no access to the Sandbox assertion path.

### Cut over Sandbox to its isolated Agent

This is a planned Sandbox maintenance window. The first release stops the old
Sandbox containers before replacing their shared secret mount; Production
remains available. Prepare both Vault policies/bundle sets, the Sandbox role ID
file, the two rendered directories, and the `.env.production` paths before
starting:

1. Set `AIHUB_SANDBOX_ENABLED=false` in `.env.production` before pushing the
   release. After CD syncs the new host files, its
   `prepare-sandbox-cutover` step removes the managed Sandbox nginx route,
   stops both Sandbox slots, and recreates the Production Agent if its rendered
   connection file still contains Sandbox fields. The active Production app
   keeps using its already-loaded snapshot during that Agent restart. Confirm
   `sandbox disabled` and one AIHUB application container in
   `blue-green-host.sh status` after CD finishes.
2. Keep Sandbox disabled while the code release runs through CI/CD. The
   Production Agent now renders only Production database/Redis data and no
   Sandbox signing bundle.
3. After Production CD passes, set `AIHUB_SANDBOX_ENABLED=true`. Start
   `vault-agent-sandbox` with Compose and wait for it to become healthy and
   authenticate:

   ```sh
   docker compose --env-file .env.production -f docker-compose.production.yml \
     --profile sandbox up -d vault-agent-sandbox
   APP_DIR="$PWD" ./scripts/ops/blue-green/blue-green-host.sh check-vault-agent sandbox
   ```

   Run the Sandbox `vault:smoke` check from a Vault CLI session authenticated
   as the Sandbox AppRole before starting the app.

4. Deploy the verified image to Sandbox with
   `AIHUB_IMAGE=ghcr.io/aihub-ecosystem/aihub-be:<commit-sha> ./scripts/ops/blue-green/blue-green-host.sh deploy sandbox`,
   then run `finalize`. With no Sandbox route, the helper bootstraps one app
   against the isolated directory and adds the managed route only after its
   health and dependency checks pass.
5. Run `ops/status.sh <commit-sha>` and confirm both tiers use that image and
   pass health/readiness checks. Inspect each app's `/run/secrets/aihub` mount
   and confirm the Production and Sandbox source directories differ. Do not
   print or copy any rendered secret contents.

## Start the Vault-backed stack

Validate interpolation first; this does not start containers:

```sh
docker compose --env-file .env.production \
  -f docker-compose.production.yml config --quiet
```

Before recreating Vault Agent, verify its operator-provisioned role ID file.
The current AppRole uses `bind_secret_id=false`, so the Agent re-authenticates
with that role ID and needs no one-use SecretID. CD does not provision roles.
Its #351 cutover step recreates the Production Agent only when it detects the
old shared connection document and Sandbox is disabled. Other rollouts that
change the rendered document schema must follow the coordinated release
sequence below before changing mounted files.

Build or pull the release, start dependencies and Vault Agent, run migrations once,
then start the app:

```sh
docker compose --env-file .env.production -f docker-compose.production.yml build app
docker compose --env-file .env.production -f docker-compose.production.yml up -d vault-agent
docker compose --env-file .env.production -f docker-compose.production.yml --profile migration run --rm migrate
docker compose --env-file .env.production -f docker-compose.production.yml --profile migration --profile sandbox run --rm migrate-sandbox
docker compose --env-file .env.production -f docker-compose.production.yml up -d app
docker compose --env-file .env.production -f docker-compose.production.yml --profile sandbox up -d app-sandbox
# Replace api.example.com with AIHUB_PRODUCTION_HOST from .env.production.
curl --fail https://api.example.com/health
```

Run the two Sandbox-profile commands only when `AIHUB_SANDBOX_ENABLED=true`.

### Adding the standalone MFA keyring

The MFA cipher reads `/run/secrets/aihub/auth-mfa-secrets.json`, separate from
the strict `runtime-secrets.json` document. Prepare it before the first release
that writes MFA state:

1. Add the read path from `ops/vault/policies/aihub-production-runtime.hcl` to
   the production runtime policy and provision
   `secret/aihub/production/auth-mfa` with `current_key_id` and `keys`.
2. Add
   `AIHUB_AUTH_MFA_SECRETS_FILE=/run/secrets/aihub/auth-mfa-secrets.json` to
   `.env.production`. Copy the new Agent HCL and template to the host, then
   recreate only `vault-agent` so it starts rendering the separate keyring.
3. Check that the keyring file exists, the Agent authenticated recently, and
   the existing runtime and connection documents are unchanged. Do not print
   any key values. The running N-1 app ignores the new file and its environment
   variable, so it can keep serving during this preparation.
4. Merge and deploy the writer release only after those checks. The deployed
   #489 reader skips the new outbox kinds until the writer is present.

Rollback to N-1 can leave the separate keyring file, Agent template, and Vault
read grant in place. The old image ignores them, and the MFA migrations are
additive; do not delete factor data or key versions during an image rollback.

### Release order when a rollout adds a runtime secret

CD deploys `main` without normally restarting `vault-agent`; the #351
Sandbox-isolation step is a narrow exception when the Production connection
document still has its old Sandbox fields. The new image must have its required
secrets at startup, but the rendered document must also remain valid for every
image still using it. The pre-Web-Session image rejects the new
`web-session` root key, so rendering that key while an old container can restart
is unsafe. Production and staging use the following coordinated cutover, with
planned downtime for the application:

1. Provision the new KV bundle and its read policy first. Keep the live Agent
   templates and rendered documents unchanged; keep new templates outside the
   Agent's mounted paths until the cutover. Record the previous image digest and
   preserve its non-secret templates and deployment manifests for rollback.
2. Hold automatic CD **before merging** and wait for any running deployment to
   finish. Disable the CD workflow for this operator-managed release, or hold it
   with deployment protection before its manifest-sync step. CD copies templates
   into the Agent's mounted paths, so holding only app startup is too late.
3. Merge, wait for successful CI, and pull the verified immutable release image.
   Keep CD held; the old image and compatible secret document continue serving
   while the new image is prepared.
4. Enter the maintenance window. Suspend scheduled CLI jobs and wait for old jobs
   to finish. Explicitly stop every old-image consumer of the shared document:
   `app` and, when enabled, `app-sandbox`. Use Compose `stop` so
   `restart: unless-stopped` cannot restart them against the new document.
5. With old consumers stopped, install the new deployment manifests and Agent
   templates, then recreate `vault-agent` so it loads the new bind-mounted files.
   Confirm both documents render, the `web-session` bundle has a non-empty
   `client_secret`, and recent authentication
   or renewal is logged. Check without printing secret values, using
   [Checking deployed state](#checking-deployed-state); a running container alone
   is not evidence of authentication.
6. Run migrations with the verified new image and replace the stopped application
   containers with that image. Use `--no-deps` only after the Agent checks above,
   as CD does. Check production and enabled sandbox health, then resume CLI jobs
   and automatic CD for the same release.

For rollback, keep CD and CLI jobs held and stop the new application containers
first. Restore the previous Agent templates and manifests, recreate the Agent,
and confirm it has rendered the old-compatible document **without** the
`web-session` root key before starting the previous image. Rolling back only the
image leaves the old reader unable to boot. Do not delete database data as part
of this secret-document rollback.

The Customer Web BFF client secret authenticates the Web Session route group's
`X-AIHUB-Client-Secret`. Production and staging refuse to boot without its
rendered bundle; missing development/test configuration makes the routes answer
`503` rather than admitting every caller.

The `vault-agent` healthcheck requires all three rendered bundles and a reachable
`metrics_only` listener bound to the Agent container's loopback. This listener
does not add capabilities to the runtime AppRole. Healthcheck output names the
failure without printing metric payloads or credentials. The deployed Agent's
metrics response does not currently include the documented
`vault.agent.authenticated` gauge, so CD verifies that the container is running,
both bundles are present, and an auth or renewal log occurred within the last
hour instead of trusting that false-negative health state.

To inspect the Agent manually, verify all three bundles and that its metrics listener
responds. Compose health alone is not evidence of authentication:

```sh
vault_container_id="$(sudo -n docker compose --env-file .env.production \
  -f docker-compose.production.yml ps -q vault-agent)"
sudo -n docker inspect --format '{{json .State.Health}}' "$vault_container_id"
sudo -n docker exec "$vault_container_id" sh -ec \
  "test -s /run/secrets/aihub/runtime-secrets.json && \
   test -s /run/secrets/aihub/auth-mfa-secrets.json && \
   test -s /run/secrets/aihub/connection-secrets.json && \
   wget -q -T 2 -O /dev/null 'http://127.0.0.1:8220/agent/v1/metrics?format=prometheus'"
```

The command verifies that the metrics listener responds; it does not prove
authentication. A successful `vault status` is not evidence of Agent
authentication; it reports Vault server state. CD uses `--no-deps` for
migrations and app startup only after its direct bundle and recent-auth checks,
so Compose's stale health state cannot block a release. The #351 preparation
step is the exception to CD's normal behavior: it recreates the Production
Agent only for the isolated-secret cutover, using its provisioned role ID.
Other Agent restarts remain operator-managed.

The migration container is one-shot. Do not run `docker compose down -v`; the
Postgres and Redis data belong to the existing VPS stacks. Back up the existing
`aihub` database before running a new migration set.

## The public edge

nginx on the host terminates TLS for every site on this VPS and proxies AIHUB to
`127.0.0.1:${AIHUB_APP_PORT}` for production and
`127.0.0.1:${AIHUB_SANDBOX_APP_PORT}` for sandbox. This Compose stack publishes
no public port and contains no reverse proxy; an earlier containerized proxy
service never ran here and was removed after it failed a release by trying to
bind port 80 against nginx.

**This VPS is shared.** `/etc/nginx/sites-enabled/` serves eleven sites, most of
them unrelated to AIHUB, and `docker ps` lists around twenty containers from
several projects. Taking port 80 or 443 from nginx takes those sites down with
it. Do not stop nginx, do not add a container that binds those ports, and do not
"free up" a port that appears to be in use. AIHUB owns only its API and Sandbox
virtual hosts, [`ops/nginx/00-aihub-log-format.conf`](../../ops/nginx/00-aihub-log-format.conf),
and its access-log rotation file; the other hostnames and their Certbot blocks
stay operator-managed.

### Managed nginx configuration

The operator-managed `/etc/nginx/conf.d/aihub.conf` retains the apex frontend,
Certbot redirects, and legacy alias. CD manages the API and Sandbox virtual
hosts, `/etc/nginx/conf.d/00-aihub-log-format.conf`, and
`/etc/logrotate.d/aihub-access`. On a host being migrated to these managed
files, perform this one-time migration during a supervised change window:

1. Back up `/etc/nginx` and capture current behavior of both AIHUB hosts and at
   least one unrelated site.
2. Copy only the TLS and port-80 `api.aihubproduction.com` server blocks into
   `/etc/nginx/conf.d/aihub-api.conf`. Preserve the frontend/apex blocks,
   Certbot redirects, and `aihub-api.aihubproduction.com` alias in `aihub.conf`.
3. If `nginx -t` reports `aihubproduction.com` or
   `www.aihubproduction.com` conflicting on port 80, inspect the active blocks
   with `sudo nginx -T`. On this VPS, `/etc/nginx/sites-enabled/aihub` was a
   stale HTTP proxy for those names, duplicating the canonical redirects in
   `conf.d/aihub.conf`. Back up the file and disable only that stale port-80
   block after confirming the canonical redirects remain enabled. Do not
   disable the apex TLS/frontend blocks in `conf.d/aihub.conf` or change other
   sites. Stop and investigate if the warning names another host or file.
4. Run `sudo nginx -t`, reload once, then verify apex and `www` HTTP redirect
   to HTTPS, `/health` on both AIHUB hosts,
   `/metrics` and `/ready` return 404, and the unrelated site still works.
   Probe the public grading route without an API key; it must return the app's
   JSON `401` without dispatching to the provider or consuming quota:

   ```sh
   response_file="$(mktemp)"
   status="$(curl -sS -o "$response_file" -w '%{http_code}' -X POST \
     https://api.aihubproduction.com/v1/ielts/speaking/grading)"
   test "$status" = 401
   jq -e 'has("error")' "$response_file" >/dev/null
   rm -f "$response_file"
   ```

   Do not expect this `401` to be gzip-compressed: stock nginx's gzip filter
   only accepts status 200, 403, and 404. CI verifies compressed `200` verdict
   responses and `Vary: Accept-Encoding` using the captured fixture.

5. Confirm `logrotate` is installed, prepare the staging directory, and install
   the reviewed helper as root before enabling its CD invocation.

Production cleanup completed 2026-10-10: the stale port-80 block in
`/etc/nginx/sites-available/aihub` was disabled; its symlink remains enabled but
contains no server block. The canonical redirects and frontend TLS blocks stay
in `conf.d/aihub.conf`. After reload, `nginx -t` was clean, apex and `www` HTTP
returned 301, and Production, Sandbox, and an unrelated site's HTTPS health
probes returned 200.

```sh
sudo install -d -o <deploy-user> -g <deploy-user> -m 0750 \
  /var/lib/aihub-nginx-staging
sudo install -o root -g root -m 0755 ops/nginx/aihub-nginx-apply \
  /usr/local/sbin/aihub-nginx-apply
```

Add exactly this sudoers command for the deploy user using `visudo`:

```sudoers
<deploy-user> ALL=(root) NOPASSWD: /usr/local/sbin/aihub-nginx-apply
```

CD stages the API config, the HTTP-context log format, the logrotate policy,
and, when `AIHUB_SANDBOX_ENABLED=true`, the Sandbox config in
`/var/lib/aihub-nginx-staging`. The no-argument root-owned helper changes only
the two AIHUB virtual hosts, the AIHUB log-format include, and the AIHUB
logrotate file. It creates the active access log as `root:adm` mode `0640` or
tightens its existing permissions without truncating it. It validates
logrotate and nginx before reload and restores the previous config files if
install, validation, or reload fails. With Sandbox disabled, it removes only
`/etc/nginx/conf.d/sandbox.conf`. Operators review and install helper updates;
CD cannot replace its code. The helper verifies the staged logrotate file
against its pinned SHA-256 because its `postrotate` command runs as root. If a
config update fails, it keeps the active log file and restrictive permissions;
rollback never deletes records or restores a broader mode.

Both AIHUB hosts write to `/var/log/aihub-access.log`; this does not change the
shared `/var/log/nginx/access.log` or another site's logging. Each JSON record
contains only the observed IP, upstream `X-Request-Id`, method, `$uri` without
the query string, and status. `/etc/logrotate.d/aihub-access` uses a 10 MiB
threshold and keeps four rotated files, for five files including the active
one. Its retained time window varies with request volume. The helper creates
the active file as `root:adm` mode `0640` (or tightens those permissions
without truncating existing records); logrotate uses the same mode after
rotation. The active file may exceed the threshold between host logrotate
runs.

Do not enable this CD step until migration and bootstrap are complete. The API
and Sandbox configs keep the 27 MiB request ceiling, 75-second proxy timeouts,
forwarding headers, HSTS, hidden nginx version, and edge 404s for `/metrics`
and `/ready`. Both `Host` and `X-Forwarded-Host` are set from nginx's routed
`$host`; the latter must not pass through caller input because the app resolves
its runtime environment from the hostname.

Speaking gzip is scoped to JSON responses from the two grading routes. The
multipart audio request passes unchanged, and request buffering is disabled
only for raw multipart grading. CI checks the actual nginx locations with the
captured verdict fixture and no provider call. The app sets
`Cache-Control: no-store` on both grading routes for privacy.

The workflow step is gated by the repository Actions variable
`AIHUB_MANAGED_NGINX`. Leave it unset during initial rollout; set it to the
string `true` only after the supervised migration, staging directory, helper,
and sudoers entry have been verified. This lets normal app deployments proceed
while the operator-owned cutover is pending.

### Unix socket ingress (optional)

By default nginx reaches the app through the slot's published loopback port.
Setting `AIHUB_SOCKET_DIR` in `.env.production` makes the apps also serve on a
Unix socket in that host directory and makes nginx use it. Over a socket the
caller address is the entry nginx appended, resolved from the socket peer alone,
so no host process can present itself as the proxy by connecting to a port.

Prepare the directory once, before setting the variable. The app runs as UID/GID
`10001`, and nginx's worker user must be able to connect, so the directory needs
a group both share (replace `<nginx-group>` with the worker's group):

```sh
sudo install -d -o 10001 -g <nginx-group> -m 2770 /srv/aihub/socket
```

Then add `AIHUB_SOCKET_DIR=/srv/aihub/socket` to `.env.production` and deploy as
usual. Each slot creates `<service>.sock` there (`app`, `app-slot-b`,
`app-sandbox`, `app-sandbox-slot-b`) with mode `0660`.

What changes, and what does not:

- A container started with the socket listens on TCP only on its own loopback
  (health checks and `/ready` use that), so its published port no longer leads to
  the app. The deploy script therefore renders nginx per slot: a slot whose
  container was started with the socket gets its socket path, and a slot whose
  container predates it (the one a rollback returns to) keeps its port.
- The first deploy after setting the variable switches the candidate slot to the
  socket and leaves the live slot on its port. After the next successful deploy
  both tiers are on sockets.
- `ops/status.sh` reads either form, so "Checking deployed state" works before and
  after.
- To go back, unset `AIHUB_SOCKET_DIR` and deploy. The new slot starts on its
  port, and the deploy script reads the old socket config while it switches.
- `AIHUB_TRUSTED_PROXY_IP` is still required and is ignored on a socket.
- If nginx cannot connect (`502` with `Permission denied` in the nginx error
  log), the directory group or its mode is wrong. The deploy's edge probe fails
  and the rollout rolls back.

### Publishing another hostname

certbot cannot create a server block, only attach a certificate to one that
already exists. Running `certbot --nginx -d <new host>` first obtains the
certificate and then fails to install it:

```
Could not automatically find a matching server block for <new host>.
Set the `server_name` directive to use the Nginx installer.
```

So write the block first, then let certbot fill in the TLS lines — or write
them against the certificate paths certbot reports. The Sandbox block is
versioned in `ops/nginx/sandbox.conf` and installed by the managed helper after
the migration and bootstrap above.

The sequence:

```sh
cp -r /etc/nginx ~/nginx-backup-$(date +%Y%m%d-%H%M%S)   # rollback point
sudo certbot --nginx -d <new host>                        # obtains the cert
sudo nano /etc/nginx/conf.d/<name>.conf                   # write the block
sudo nginx -t && sudo systemctl reload nginx
```

DNS must already point at this VPS or certbot cannot complete the challenge.

Verify afterwards that the new hostname answers **and** that an unrelated site
still does. One reload serves every site on this box.
Setting `AIHUB_SANDBOX_HOST` in `.env.production` only teaches the application
to recognise the hostname; without the nginx block, nothing reaches it. The
sandbox block must point at `AIHUB_SANDBOX_APP_PORT`, never at the production
port, or the data boundary is bypassed at the edge.

Never add a wildcard or default server block. nginx refusing an unknown
hostname is what makes the application's environment binding trustworthy —
`Host` is client-supplied, and the edge serving only names it was given is the
half of that guarantee the application cannot enforce itself.

### Disabling the sandbox tier

Set `AIHUB_SANDBOX_ENABLED=false` and remove `AIHUB_SANDBOX_HOST` and
`AIHUB_SANDBOX_ORG_IDS` together. The next `main` deployment removes the
managed nginx Sandbox file and stale `app-sandbox` container. It does not drop
`aihub_sandbox`; retain that database until its backup and disposal have been
approved separately.

## Container stdout and stderr logs (#363)

Every service in `docker-compose.production.yml` uses Docker's `json-file`
driver with `max-size: 10m` and `max-file: 3`. Docker retains at most three
files of up to 10 MB each, for a configured maximum of 30 MB per container.
The Compose file declares seven services, so even if every profile and
migration service runs at once, their combined configured maximum is 210 MB.
CI renders the complete Compose file and fails if any service is missing these
options. This limit covers Docker-managed container stdout and stderr; it does
not include the separate `deploy-logs/` snapshots described in the blue-green
section below.

Before the first deployment that applies these options, record the host's
existing Docker log defaults on #363. Record only the logging keys (or that the
file is absent), not unrelated daemon settings:

```sh
sudo python3 -c 'import json,pathlib; p=pathlib.Path("/etc/docker/daemon.json"); print("absent" if not p.exists() else json.dumps({k: json.loads(p.read_text()).get(k) for k in ("log-driver", "log-opts")}, sort_keys=True))'
sudo docker info --format 'default_log_driver={{.LoggingDriver}}'
```

After deployment, inspect the actual container settings and record the output
on #363. Existing containers keep their previous logging configuration until
they are recreated.

```sh
for id in $(sudo docker ps -aq --filter label=com.docker.compose.project=aihub-production); do
  sudo docker inspect --format '{{.Name}} driver={{.HostConfig.LogConfig.Type}} options={{json .HostConfig.LogConfig.Config}}' "$id"
done
```

The expected values are `json-file`, `max-size: 10m`, and `max-file: 3` for
each returned AIHUB container.

## Verify and operate

### Checking deployed state

`ops/status.sh` reports, for the production and Sandbox containers, the commit
each runs, its state and health, `/health` and `/ready` probes from inside the
container, its restart count, and the number of error-like log lines since it
started. It changes nothing. Nothing is installed on the host; the script
travels over stdin, and the host user needs the same `sudo -n docker` access the
deploy uses:

```sh
ssh <user>@<host> 'bash -s -- <expected-commit-sha>' < ops/status.sh
```

Pass the commit you expect (for example `git rev-parse origin/main`) and a
container on any other commit is reported `FAIL`, so "is the latest code live?"
has a yes-or-no answer. The exit status is 1 when any container is missing, not
running, not healthy, failing either probe, or on another commit. A non-zero
`errors=` count is not a failure by itself: read those lines, because they
include real errors such as a downstream contract violation.

Use an SSH key for this, not a password: a credential pasted into a chat or a
ticket stays in its history.

A container's logs are deleted with the container, and every deploy replaces
it. So before it recreates `app` and `app-sandbox`, the deploy saves the last
20 MB from each running container to
`deploy-logs/<service>-<commit>-<time>.log` under the app directory (mode
`700`); files older than 30 days are removed. Saving is best effort and never
blocks a release. These snapshots also contain request IPs after #450 and must
be included in #287's personal-data and retention record.

### Diagnosing unmatched API 404s

A `request_completed` event with `route: "unmatched"` and `http_status: 404`
means Fastify did not match the request to an application route. AIHUB returned
its normal client-facing `NOT_FOUND` response (`outcome: "client_error"`). This
is a route miss, not a failure in a matched handler or a downstream service. A
matched route that returns 404 has its route template in `route` and needs to
be diagnosed against that route. An Nginx-generated 404 does not reach the app
and therefore has no AIHUB `request_completed` event.

The completion event intentionally has no raw path, query, or body. Its
AIHUB-generated `request_id` is returned in `X-Request-Id` and shared with the
AIHUB nginx access record. Use that identifier to join the event to the path
and status logged by nginx. The event also has `client_ip` and
`client_ip_source`; `customer_web_bff` identifies the BFF address after its
client-secret guard succeeds. A failed guard is classified from the network
path as `nginx` or `direct_peer`. No end-user forwarded address is recorded
until #436 validates that contract.

Production and Sandbox events come from separate app containers, and an
unmatched request may not have an `environment` field. The lookup below checks
both tiers and their retained `deploy-logs/` snapshots by request ID.

Run the lookup from the AIHUB deployment directory. It searches the active and
rotated Docker logs for all Production and Sandbox slots, retained container
snapshots under `deploy-logs/`, and active or rotated AIHUB nginx access logs.
It prints only the application route/status/outcome and nginx method/path/status
for the exact request ID. A missing record or an unreadable source is reported
separately; it never infers a match from time or path:

```sh
./scripts/ops/logs/request-log-lookup.sh req_01ARZ3NDEKTSV4RRFFQ69G5FAV
```

Run it as an account that already has access to `deploy-logs/` and
`/var/log/aihub-access.log*`; the latter is `root:adm` mode `0640`. The script
uses non-interactive sudo only for Docker log reads and does not elevate nginx
log access. Do not run the whole command with sudo to bypass those permissions.

An nginx-generated response does not have an AIHUB request ID because it never
reached the application; its access record therefore has an empty `request_id`.

### Optional request tracing

Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` in `.env.production` to an OTLP/HTTP
traces endpoint reachable from the application container, for example
`http://otel-collector:4318/v1/traces`. AIHUB sends traces to that receiver;
the production Compose stack does not run a collector or trace store. Leave the
value blank to keep instrumentation disabled. `app` and `app-sandbox` use the
same endpoint setting.

Each trace contains a Fastify request span and child spans for ioredis, Postgres,
and Undici downstream calls. The root span records the route template, generated
request ID, method, and response status. Redis arguments, SQL text beyond the
operation name, downstream URL credentials and query values, request bodies,
credentials, and baggage are not exported.
OTLP export is batched asynchronously and is not awaited by the request path.

After changing the endpoint, recreate the app containers:

```sh
docker compose --env-file .env.production \
  -f docker-compose.production.yml up -d --no-deps app
docker compose --env-file .env.production \
  -f docker-compose.production.yml --profile sandbox up -d --no-deps app-sandbox
```

```sh
docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  --profile sandbox ps
docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  --profile sandbox logs --tail=100 app app-sandbox vault-agent
```

After migration, production owns the Sandbox Organization and its key and
identity-configuration rows. Usage, idempotency, and dispatch reservations stay
in `aihub_sandbox`. Check the configured Organization IDs in both databases:

```sh
sandbox_org_ids="${AIHUB_SANDBOX_ORG_IDS:?AIHUB_SANDBOX_ORG_IDS is required}"
sudo -n docker exec aihub-db psql -U aihub_admin -d aihub \
  -v sandbox_org_ids="$sandbox_org_ids" <<'SQL'
SELECT id,
       (SELECT count(*) FROM api_keys WHERE organization_id = o.id) AS api_keys,
       (SELECT count(*) FROM organization_identity_configs WHERE organization_id = o.id) AS identity_configs
FROM organizations AS o
WHERE id = ANY(string_to_array(:'sandbox_org_ids', ','));
SQL

sudo -n docker exec aihub-db psql -U aihub_admin -d aihub_sandbox \
  -v sandbox_org_ids="$sandbox_org_ids" <<'SQL'
SELECT 'organizations' AS record, count(*) FROM organizations
  WHERE id = ANY(string_to_array(:'sandbox_org_ids', ','))
UNION ALL SELECT 'api_keys', count(*) FROM api_keys
  WHERE organization_id = ANY(string_to_array(:'sandbox_org_ids', ','))
UNION ALL SELECT 'identity_configs', count(*) FROM organization_identity_configs
  WHERE organization_id = ANY(string_to_array(:'sandbox_org_ids', ','))
UNION ALL SELECT 'usage_records', count(*) FROM usage_records
  WHERE organization_id = ANY(string_to_array(:'sandbox_org_ids', ','))
UNION ALL SELECT 'idempotency_records', count(*) FROM idempotency_records
  WHERE organization_id = ANY(string_to_array(:'sandbox_org_ids', ','))
UNION ALL SELECT 'dispatch_reservations', count(*) FROM sandbox_dispatch_reservations
  WHERE organization_id = ANY(string_to_array(:'sandbox_org_ids', ','));
SQL
```

Expect the control-plane counts for each configured Organization in production,
and zero Organization, key, and identity-configuration rows in Sandbox. Any
Sandbox usage, idempotency, or reservation history remains in the sandbox
database. The production backup includes the migrated control-plane records;
store it with the same restricted access as other production backups.

Use real sandbox and production keys for the final boundary checks: a sandbox
key on the production hostname and a production key on the sandbox hostname
must both be rejected. Dropping `aihub_sandbox` is the destructive test and is
only appropriate on a disposable rehearsal; the production backup above is the
rollback point, not a reason to drop the live database.

Back up the existing Postgres before releases and test restore separately.
Rotate compromised downstream credentials using the Vault runbook, then
restart the matching Agent and app so the startup snapshot is re-rendered. The
Agents use role IDs with `bind_secret_id=false`; do not mint or rotate a
`secret_id`. If a role ID is compromised, rotate the affected AppRole and
install its replacement role ID in that tier's host file before restarting
its Agent. Certificates are renewed by certbot on the host, not by this stack.

## AI Speaking Production handoff

The release image contains the authenticated multipart smoke helper. Run it from
the VPS with a real WAV fixture after a deployment; set
`AIHUB_API_KEY_FILE` to a restricted file containing a key for the same tier as
`AIHUB_BASE_URL`. The helper reads that key and the assertion-signing key from
their restricted files, keeps them out of output, and removes its in-container
key copy on exit:

```sh
AIHUB_API_KEY_FILE=/path/to/production-scoped-api-key \
  bash ~/speaking-gateway-smoke.sh \
  ~/aihub-speaking-contract-probe.wav
```

Expected output is `HTTP_STATUS=200`. The request is sent to
`https://api.aihubproduction.com/v1/ielts/speaking/grading` by default and must
return the normalized `{data, meta}` envelope. Run the same helper with an
explicit `AIHUB_BASE_URL` and a key file scoped to that environment when
validating another tier. The helper has no default API-key path; never send a
Sandbox key to Production.

The Production handoff matrix is split by safety boundary:

- Production smoke covers a successful authenticated multipart request and the
  public validation/authentication/size boundaries (`401`, `400`, and `413`).
- The provider `401`/`4xx`/`5xx`, throttling, timeout/cancellation, and malformed
  success mappings are covered by the Speaking HTTP seam tests; do not corrupt
  live provider credentials or deliberately overload Production to manufacture
  those failures.
- The blue-green helper probes `/health` through every enabled public hostname
  from the VPS once per second while the candidate starts, after cutover, and
  during drain. It does not follow redirects or read response bodies. The helper
  then runs `scripts/ops/monitoring/probe-runtime-dependencies.cjs` inside the candidate:
  private `/ready` must report runtime and configured control-plane Postgres
  up; Redis is reported but a Redis-only failure is advisory because gateway
  requests fail open. The container must also complete a TCP connection or
  verified TLS handshake to both configured AI service hosts. These probes send
  no HTTP request to either
  provider, so they do not authenticate or exercise grading/model behavior.
  Failures identify the hostname or dependency name and a safe status/code; raw
  response bodies and configured URLs are not logged. Sandbox checks are skipped
  when `AIHUB_SANDBOX_ENABLED=false`. CD deploys through the blue-green helper.
  The direct Compose rollback below is only for a release that predates its
  successful blue-green history. Blue-green automatic rollback covers failed
  cutover gates; a later latency or error-rate regression needs operator action.

## Rollback

CD deploys with `scripts/ops/blue-green/blue-green-host.sh`. Each successful blue-green
deployment records per-tier history in
`$APP_DIR/.aihub-deploy-state/releases.tsv`. Legacy direct Compose releases
record their history in `$APP_DIR/.aihub-deploy-state/direct-releases.tsv`
(directory mode `0700`, file mode `0600`) and in the CD Actions summary. A
failed CD run may leave pending state; it is not successful history. Use the
history for the release method that deployed the running tier. `.env.production`
is configuration, not release history. Check GitHub Actions before host work:
disabling CD does not cancel a run already in progress.

### Pause CD and select the rollback target

From an authenticated GitHub CLI session, stop new CD workflow runs, then wait
for any run already deploying to finish. Disabling a workflow does not cancel a
run already in progress:

```sh
gh workflow disable cd.yml
gh run list --workflow cd.yml --status in_progress
gh workflow list --all
```

Do not change the host while a CD run is applying a release. Verify the
workflow is disabled and no run is active. Use `blue-green-host.sh status` to
read the active tier revisions. For a blue-green release, use its `releases.tsv`
history and the helper below; for a legacy direct Compose release, use
`direct-releases.tsv` and its matching Actions summary. Never infer the previous
SHA from `.env.production`.

GHCR was checked on 2026-10-09: the private package had 150 tagged versions,
the oldest tagged version was from 2026-09-18, and the current and preceding
commit-SHA image tags were present. This repository has no image cleanup
workflow. The rollback retention floor is two SHA tags: the current release and
its previous successful release. ADR-0064 currently retains every SHA tag; do
not add cleanup that removes this floor. #115 may set a finite depth later, but
it must preserve at least these two releases. Before rollback, verify the
chosen tag is still listed in the private package. The blue-green helper runs
`sudo -n docker compose pull`, so authenticate that Docker daemon to GHCR with
an operator-managed `read:packages` credential through
`sudo -n docker login ghcr.io --username "$GHCR_USERNAME" --password-stdin`;
log out after rollback. Never put the token in `.env.production` or a command
argument. The legacy direct Compose command below checks the local cache and
performs a temporary login only when the target image is absent.

### Roll back a blue-green release

Use the helper when the tier has a successful blue-green deployment in
`releases.tsv`. It selects the previous recorded image, and refuses if the
active nginx route does not match the latest deployment record. It starts and
checks the candidate, switches only the selected tier, and confirms public
health, dependencies, readiness, and resource state before draining the old
slot. Run one tier at a time. If rollback cannot be confirmed, preserve both
slots and stop for operator repair.

After the pause and GHCR authentication steps above, inspect status from the
deployment directory:

```bash
cd "$APP_DIR"
APP_DIR="$PWD" ./scripts/ops/blue-green/blue-green-host.sh status
```

Then run exactly one command for the affected tier. For Production:

```bash
APP_DIR="$PWD" ./scripts/ops/blue-green/blue-green-host.sh rollback production
```

For Sandbox:

```bash
APP_DIR="$PWD" ./scripts/ops/blue-green/blue-green-host.sh rollback sandbox
```

### Legacy direct Compose rollback

Use this only when the running release has no successful blue-green history.
Use the exact 40-character target SHA selected above. This updates both enabled
tiers to the same image, matching the legacy direct-Compose behavior. It leaves
the expand-only schema in place and never deletes the database volume or runs a
down-migration. In the same Bash session, record
`recovery_started=$(date +%s)` immediately before changing `AIHUB_IMAGE`; once
all health and authenticated probes pass, calculate
`recovery_seconds=$(($(date +%s) - recovery_started))` and save it in the
incident notes. This full-tier command is for an incident; use the Sandbox-only
procedure below for a rehearsal so Production keeps serving its current
container.

```bash
set -euo pipefail
# Use the deployment directory configured as VPS_APP_DIR.
: "${APP_DIR:?set APP_DIR to VPS_APP_DIR}"
cd "$APP_DIR"
rollback_sha='PASTE_40_CHARACTER_SHA_HERE'
[[ "$rollback_sha" =~ ^[a-f0-9]{40}$ ]]
rollback_image="ghcr.io/aihub-ecosystem/aihub-be:$rollback_sha"
if ! sudo -n docker image inspect "$rollback_image" >/dev/null 2>&1; then
  read -r -p 'GHCR username: ' GHCR_USERNAME
  read -r -s -p 'GHCR read:packages token: ' GHCR_PULL_TOKEN
  printf '\n'
  if ! printf '%s' "$GHCR_PULL_TOKEN" | sudo -n docker login ghcr.io \
    --username "$GHCR_USERNAME" --password-stdin; then
    unset GHCR_PULL_TOKEN
    exit 1
  fi
  pull_status=0
  sudo -n docker pull "$rollback_image" || pull_status=$?
  sudo -n docker logout ghcr.io >/dev/null 2>&1 || true
  unset GHCR_PULL_TOKEN
  test "$pull_status" -eq 0
fi
env_tmp="$(mktemp .env.production.rollback.XXXXXX)"
awk '!/^AIHUB_IMAGE=/' .env.production >"$env_tmp"
printf 'AIHUB_IMAGE=%s\n' "$rollback_image" >>"$env_tmp"
chmod 600 "$env_tmp"
mv "$env_tmp" .env.production
compose=(sudo -n docker compose --env-file .env.production -f docker-compose.production.yml)
services=(app)
if grep -qx 'AIHUB_SANDBOX_ENABLED=true' .env.production; then
  compose+=(--profile sandbox)
  services+=(app-sandbox)
fi
"${compose[@]}" up -d --no-deps --no-build "${services[@]}"

for service in "${services[@]}"; do
  container_id="$("${compose[@]}" ps -q "$service")"
  health=starting
  for attempt in $(seq 1 45); do
    health="$(sudo -n docker inspect --format '{{.State.Health.Status}}' "$container_id")"
    [ "$health" = healthy ] && break
    [ "$health" != unhealthy ] || break
    sleep 2
  done
  test "$health" = healthy
  revision="$(sudo -n docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container_id")"
  test "$revision" = "$rollback_sha"
  sudo -n docker exec "$container_id" node scripts/ops/monitoring/probe-runtime-dependencies.cjs
done

AIHUB_PRODUCTION_HOST="$(sed -n 's/^AIHUB_PRODUCTION_HOST=//p' .env.production | tail -n 1)"
AIHUB_SANDBOX_HOST="$(sed -n 's/^AIHUB_SANDBOX_HOST=//p' .env.production | tail -n 1)"
curl --fail --silent --show-error "https://$AIHUB_PRODUCTION_HOST/health" >/dev/null
if grep -qx 'AIHUB_SANDBOX_ENABLED=true' .env.production; then
  curl --fail --silent --show-error "https://$AIHUB_SANDBOX_HOST/health" >/dev/null
fi
```

Wait for every selected service's container health to become `healthy`; verify
the container revision label equals `rollback_sha`, and check the public
`/health` on every enabled hostname. Provision temporary, least-scope API keys
separately for Production and Sandbox with `key:create` from
[`sandbox-provisioning.md`](sandbox-provisioning.md), setting `--envs` to only
the intended tier and recording the issuance under the operator's AIHUB
username. Store each raw key in a mode-`600` file outside the repository. Set
`AIHUB_PRODUCTION_API_KEY_FILE` and, when Sandbox is enabled,
`AIHUB_SANDBOX_API_KEY_FILE` to those separate paths. Never send a Sandbox key
to Production or reuse a Production key on Sandbox.

Use an active Sandbox Organization on the Sandbox allowlist with an active
identity configuration for the Sandbox key. Use an active Production test
Organization with the `speaking` entitlement and no active identity
configuration for the Production key. The Sandbox probe mints a short-lived
credential, so discard the body and print only the HTTP status. The Production
probe sends an empty JSON object to the Speaking JSON route; its request schema
rejects the body with `400` after API key and User Identity authentication but
before downstream dispatch. It proves Production authentication without
calling the AI provider. It still updates the API key's `last_used_at` and
consumes one rate-limit slot.

```bash
probe_auth() {
  (
    set -euo pipefail
    local host="$1" key_file="$2" path="$3" expected="$4" json="$5" identity="${6:-}" dir config body status
    test -r "$key_file"
    dir="$(mktemp -d)"
    chmod 700 "$dir"
    config="$dir/curl.conf"
    body="$dir/body.json"
    trap 'rm -f "$config" "$body"; rmdir "$dir"' EXIT
    printf '%s\n' "$json" >"$body"
    chmod 600 "$body"
    {
      printf 'url = "https://%s%s"\n' "$host" "$path"
      printf 'request = "POST"\n'
      printf 'header = "X-API-Key: %s"\n' "$(cat "$key_file")"
      printf 'header = "Content-Type: application/json"\n'
      if [ -n "$identity" ]; then
        printf 'header = "X-User-Identity: %s"\n' "$identity"
      fi
      printf 'data-binary = "@%s"\n' "$body"
    } >"$config"
    chmod 600 "$config"
    status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --config "$config")"
    printf '%s %s\n' "$host" "$status"
    test "$status" = "$expected"
  )
}

: "${AIHUB_PRODUCTION_API_KEY_FILE:?set to the Production-scoped API key file}"
probe_auth "$AIHUB_PRODUCTION_HOST" "$AIHUB_PRODUCTION_API_KEY_FILE" \
  /v1/ielts/speaking/grading-json 400 '{}' rollback-probe
AIHUB_SANDBOX_HOST="$(sed -n 's/^AIHUB_SANDBOX_HOST=//p' .env.production | tail -n 1)"
AIHUB_SANDBOX_ENABLED="$(sed -n 's/^AIHUB_SANDBOX_ENABLED=//p' .env.production | tail -n 1)"
if [ "$AIHUB_SANDBOX_ENABLED" = true ]; then
  test -n "$AIHUB_SANDBOX_HOST"
  : "${AIHUB_SANDBOX_API_KEY_FILE:?set to the Sandbox-scoped API key file}"
  probe_auth "$AIHUB_SANDBOX_HOST" "$AIHUB_SANDBOX_API_KEY_FILE" \
    /v1/sandbox/assertions 200 '{"user_id":"rollback-probe"}'
fi
```

Use a dedicated test Organization for each key; the Production test
Organization must have no active identity configuration so `rollback-probe` is
accepted as a Declared User ID. Do not use a customer key or the successful
Speaking grading smoke for this rollback check. Revoke both temporary keys and
remove their files after the rehearsal. If either probe does not return its
expected status, keep CD disabled and treat rollback as unconfirmed.
The `/metrics` scrape also exposes unknown queued rows in the fixed
`aihub_email_outbox_queued{kind="unknown"}` series and their oldest age; raw
stored values are never metric labels.

### Legacy Sandbox-only direct-Compose rehearsal rollback

Use this variant only after CD is disabled, no deploy run is active, Sandbox
is enabled, and the rollback image passed the registry/cache checks above. It
changes the shared desired `AIHUB_IMAGE` in `.env.production`, but recreates
only `app-sandbox`; the running Production container must keep the same ID and
revision throughout. Run it in the same Bash session as
`probe_auth` above so the recovery timer includes the Production and Sandbox
auth probes. Only rehearse after a normal later release has written a new
stored value in Sandbox. Confirm that
value exists using release-specific evidence without printing payloads or
secrets; do not seed the database manually to simulate a writer release.

```bash
set -euo pipefail
: "${APP_DIR:?set APP_DIR to VPS_APP_DIR}"
: "${AIHUB_PRODUCTION_API_KEY_FILE:?set to the Production-scoped API key file}"
: "${AIHUB_SANDBOX_API_KEY_FILE:?set to the Sandbox-scoped API key file}"
cd "$APP_DIR"
test "$(sed -n 's/^AIHUB_SANDBOX_ENABLED=//p' .env.production | tail -n 1)" = true
rollback_sha='PASTE_40_CHARACTER_SHA_HERE'
[[ "$rollback_sha" =~ ^[a-f0-9]{40}$ ]]
rollback_image="ghcr.io/aihub-ecosystem/aihub-be:$rollback_sha"
sudo -n docker image inspect "$rollback_image" >/dev/null
production_compose=(sudo -n docker compose --env-file .env.production -f docker-compose.production.yml)
sandbox_compose=(sudo -n docker compose --profile sandbox --env-file .env.production -f docker-compose.production.yml)
production_id_before="$("${production_compose[@]}" ps -q app)"
test -n "$production_id_before"
production_sha_before="$(sudo -n docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$production_id_before")"
sandbox_id_before="$("${sandbox_compose[@]}" ps -q app-sandbox)"
test -n "$sandbox_id_before"
sandbox_sha_before="$(sudo -n docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$sandbox_id_before")"
printf 'sandbox_before_sha=%s production_before_sha=%s\n' "$sandbox_sha_before" "$production_sha_before"
recovery_started="$(date +%s)"
env_tmp="$(mktemp .env.production.rollback.XXXXXX)"
trap 'rm -f "$env_tmp"' EXIT
awk '!/^AIHUB_IMAGE=/' .env.production >"$env_tmp"
printf 'AIHUB_IMAGE=%s\n' "$rollback_image" >>"$env_tmp"
chmod 600 "$env_tmp"
mv "$env_tmp" .env.production
trap - EXIT
"${sandbox_compose[@]}" up -d --no-deps --no-build app-sandbox
sandbox_id="$("${sandbox_compose[@]}" ps -q app-sandbox)"
health=starting
for attempt in $(seq 1 45); do
  health="$(sudo -n docker inspect --format '{{.State.Health.Status}}' "$sandbox_id")"
  [ "$health" = healthy ] && break
  [ "$health" != unhealthy ] || break
  sleep 2
done
test "$health" = healthy
sandbox_sha="$(sudo -n docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$sandbox_id")"
test "$sandbox_sha" = "$rollback_sha"
sudo -n docker exec "$sandbox_id" node scripts/ops/monitoring/probe-runtime-dependencies.cjs
production_id_after="$("${production_compose[@]}" ps -q app)"
test "$production_id_after" = "$production_id_before"
production_sha_after="$(sudo -n docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$production_id_after")"
test "$production_sha_after" = "$production_sha_before"
AIHUB_PRODUCTION_HOST="$(sed -n 's/^AIHUB_PRODUCTION_HOST=//p' .env.production | tail -n 1)"
AIHUB_SANDBOX_HOST="$(sed -n 's/^AIHUB_SANDBOX_HOST=//p' .env.production | tail -n 1)"
curl --fail --silent --show-error "https://$AIHUB_PRODUCTION_HOST/health" >/dev/null
curl --fail --silent --show-error "https://$AIHUB_SANDBOX_HOST/health" >/dev/null
probe_auth "$AIHUB_PRODUCTION_HOST" "$AIHUB_PRODUCTION_API_KEY_FILE" \
  /v1/ielts/speaking/grading-json 400 '{}' rollback-probe
probe_auth "$AIHUB_SANDBOX_HOST" "$AIHUB_SANDBOX_API_KEY_FILE" \
  /v1/sandbox/assertions 200 '{"user_id":"rollback-probe"}'
recovery_seconds="$(($(date +%s) - recovery_started))"
printf 'sandbox_sha=%s production_sha=%s recovery_seconds=%s\n' \
  "$sandbox_sha" "$production_sha_after" "$recovery_seconds"
```

If any command fails, keep CD disabled and do not mark the rehearsal successful.
Record the Sandbox SHA before rollback and the restored SHA in the table below.
Confirm the unknown-value metric and that valid outbox rows continue through the
normal monitoring/dispatch checks without exposing the stored value. After
recording the result, use the fix-forward release procedure in **Resume CD**;
enabling the workflow alone does not replay a missed deploy.
This Sandbox rehearsal does not substitute for the Production authenticated
request described above.

### Resume CD

Keep CD disabled until the release cause is fixed and the rollback target has
passed the health and authenticated probes. Confirm no CD run is active, then
enable the workflow:

```sh
gh run list --workflow cd.yml --status in_progress
gh workflow enable cd.yml
gh workflow list --all
```

If `main` advanced while CD was paused, do not assume enabling replays a missed
`workflow_run` event. Verify the latest successful CI run for `main`, then
explicitly rerun that run only after the fix-forward release is ready to deploy.
Follow the CD run through the public probes and the release-history summary.

### Rollback triggers and contract migrations

Start rollback when any release gate fails after deployment: a service does
not report a healthy container health check within the helper's 120 attempts
(`wait_service_ready` in `scripts/ops/blue-green/blue-green-host.sh`, one second apart),
an enabled hostname has a failed
`/health` probe during the CD probe window, `/ready` reports Postgres or Redis
down, a deployed container OOMs or its restart count increases, or the
authenticated smoke does not return `200`. Also roll back a reproducible
customer-facing regression when evidence ties it to the release. A downstream
provider outage by itself is not evidence that the app image caused the failure;
confirm provider-independent health and authentication first. If rollback does
not restore those checks, keep CD paused and repair forward.

Ordinary migrations remain expand-only, and #484 adds the two-release rule for
new persisted values plus additive configuration and Vault keys. Before any
approved contract migration, attach a reviewed migration-specific rollback
plan to the release. It must name the tested reverse migration or forward-fix
path, the write/traffic pause, and the database backup to preserve. During a
rollback, pause CD, stop writes as the plan requires, run only that reviewed and
rehearsed migration step, then start the previous image and repeat all probes.
If no safe reverse path was approved, do not run an improvised down-migration or
restore a backup over newer writes; fix forward instead. For strict Vault
bundle changes such as the Web Session key, restore the previous compatible
templates and Agent render before restarting the old image; follow the
[coordinated secret cutover](#release-order-when-a-rollout-adds-a-runtime-secret).

### Legacy direct-Compose rehearsal record

Run one rehearsal against enabled Sandbox during a quiet window. Record UTC
date, the deployed SHA, rollback target SHA, the commands/probes used, and the
elapsed time from starting rollback until health and authenticated probes pass.
Keep Production serving throughout. This procedure records a legacy direct
Compose rehearsal; it does not exercise blue-green rollback, which is covered
by the automated rehearsal recorded in #224.

| Date (UTC) | Sandbox SHA before                       | SHA restored                             | Steps and probe results                                                                                                                                                                                                                                                                                                                                                                                                                | Recovery time                                           |
| ---------- | ---------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 2026-10-10 | 00d97c5dd44cc43dcc465ecf8889b7742ff9f22a | f17a570c9381584ecad88ee8604936added3c781 | Sandbox-only rollback; Production container ID and revision stayed unchanged; health/readiness and runtime dependencies passed; Production auth 400, Sandbox auth 200; N-1 unknown-kind metric=1 while password-reset row reached provider_accepted. Fixed forward to 00d97c5; MFA login 200 and unknown-kind metric returned to 0. Fixture setup intentionally held Sandbox stopped for about 6m46 before the rollback timer started. | 9s from changing the image through authenticated probes |

## Blue-green rollout and rollback (#224)

The accepted design in
[ADR-0085](../adr/0085-per-tier-blue-green-cutover.md) is implemented by the CD
workflow and host helper. Issue #224 records the controlled Sandbox
post-cutover failure rehearsal and verified automatic rollback. The helper's
automatic rollback covers its cutover health, dependency, readiness, and
resource gates; it does not react to later SLO regressions. Use the manual
helper procedure above for a later regression. Issue #483 tracks the staging
decision and the release observation and rollback policy.

Deploy Production, then Sandbox, one tier at a time. Keep the current tier
serving while one candidate starts from the immutable CI SHA. Require private
`/ready`, switch only that tier's AIHUB nginx upstream through the fixed helper
in [ADR-0079](../adr/0079-managed-nginx-configuration-on-shared-vps.md), and
run #113's public-edge and in-container dependency smoke against the candidate.
Reject a candidate if its OOM state is set or its restart count increases during
startup or smoke; this triggers rollback while the old service is still
available. Confirm rollback with the same dependency smoke on the restored
service. Retain the old service until smoke passes, then wait for Compose's
150-second stop grace. The budget is 60 seconds for HTTP drain, 75 seconds for
background idempotent work, and 5 seconds for telemetry export, with 10 seconds
of margin. This drain relies on the background-work shutdown behavior and
lifecycle coverage completed in #284. The validated upstream is the active-slot
source of truth; the immutable image SHA and helper history identify the
release. `.env.production` is not the last-good release record.

Before each deploy, the helper reconciles `AIHUB_SANDBOX_ENABLED` with the
managed Sandbox route. Disabling Sandbox removes and validates the route before
stopping both Sandbox slots, then confirms only Production remains. Enabling it
without a route first confirms Sandbox containers are absent; after the
Production cutover, it starts Sandbox, checks private readiness and dependencies,
adds the route, and checks the public health window. The initial Sandbox release
is recorded as `disabled -> slot A`, so manual rollback can remove the route and
stop Sandbox without looking for a nonexistent previous image.

Timestamped public `/health` results are appended to
`.aihub-deploy-state/edge-probes.tsv`. Labeled resource snapshots in
`.aihub-deploy-state/resources-*.log` include host CPU and memory, Docker CPU
and memory for running containers, and state, OOM flag, and restart count for
AIHUB containers. The helper also saves the inactive slot's last 20 MB of logs
before Compose replaces that container.

Allow at most three AIHUB application containers total, reusing the single
candidate for Sandbox after Production is verified and drained. Roll back only
the tier whose smoke failed. A rollback is confirmed only when nginx validation
and reload succeed and public health plus smoke pass on that tier's hostname.
If confirmation fails, preserve both slots, fail CD, stop subsequent deploys,
and require operator repair through #289. Do not touch other nginx sites or
ports 80/443.

The controlled post-cutover smoke-failure rehearsal and automatic rollback
evidence are recorded in #224. During each rollout, probe every enabled public
hostname's `/health` every second; require no failed probes and no OOM, and
record host/container CPU, memory, and OOM events. The live host has two vCPUs
and shared workloads, so review CPU limits against measured headroom when
capacity or workload changes (#327). A running deployment is not cancelled;
the latest pending release wins.

The automatic rollback window ends after cutover, smoke, drain, and the short
final health check. It does not roll back a later error-rate or latency
regression. Until the metrics and SLO alert work in #237, #240, #292, and #412
is complete, an operator must detect the regression and use the manual helper
rollback above. #483 records the decision about the observation window and
rollback policy.

The host helper supports `status`, `rollback production`, `rollback sandbox`,
and `rehearse sandbox`. `status` reports `caller_ip_gate=<tier>` if an external
caller-IP proof still needs resolution. The CD workflow uses `public-host`,
`sandbox-enabled`, `finalize`, and `recover-gate` to sequence the per-tier
checks; do not clear an unresolved gate by editing its state file. The rehearsal
command deliberately injects a failed post-cutover smoke and succeeds only
when Sandbox is restored and verified; it does not cut over Production. Use the
immutable CI SHA for `AIHUB_IMAGE` when running it manually. The CD Actions
summary reports the active SHA for each enabled tier after both successful and
failed deploy attempts.

After syncing the reviewed helper to the VPS and logging Docker into GHCR, run
the Sandbox rehearsal from the deployment directory:

```bash
cd "$APP_DIR"
APP_DIR="$PWD" AIHUB_IMAGE=ghcr.io/aihub-ecosystem/aihub-be:REPLACE_WITH_40_CHAR_CI_SHA \
  ./scripts/ops/blue-green/blue-green-host.sh rehearse sandbox
APP_DIR="$PWD" ./scripts/ops/blue-green/blue-green-host.sh status
```

Only use `rollback <tier>` after that tier has a successful blue-green deploy
record in `releases.tsv`; the direct-Compose history above is not input to this
helper.

## GitHub Actions CD

The `CI` workflow publishes the image it booted to GHCR under the commit SHA.
After a successful CI run for a push to `main`, CD resolves that immutable SHA,
checks the registry still holds the digest CI published and the SHA is still
the tip of `main`, then syncs the helper and deployment files and deploys over
SSH. CD migrates once, then gates each enabled tier: it cuts over Production,
checks caller-IP resolution, and only then cuts over Sandbox. For each proof,
the Actions runner requests the read-only `/docs` route on the public hostname,
captures `X-Request-Id`, and asks the host to compare the matching application
completion event with the AIHUB nginx access record. The check waits up to ten
seconds for both records and prints only pass/fail. It requires
`client_ip_source=nginx` and equal application/nginx `client_ip` values. A
missing record or mismatch fails the gate and rolls back only that tier; a
passing Production release stays active if Sandbox later fails. The ordinary
`/health` smoke remains separate because health probes do not create completion
events. The host helper records `caller_ip_gate=<tier>` while a tier awaits the
external proof, and blocks another deploy until proof or rollback resolves it.
CD uses the
`production` GitHub Environment; its `main` branch allowlist is not a human
review gate, and #300 tracks the separate branch and review protections. Check
the workflow's current state before operating; this runbook does not assert
that it is enabled at every future point. The VPS must already be prepared
using this runbook, with the Compose files and `.env.production` in the app
directory. The deploy user must be allowed to run Docker non-interactively,
either directly or via passwordless `sudo -n docker`.

CD requires the `production` GitHub Environment to be configured with these
secrets:

- `VPS_HOST`
- `VPS_USER`
- `VPS_SSH_PORT` (optional; defaults to `22`)
- `VPS_APP_DIR`
- `VPS_SSH_PRIVATE_KEY`
- `VPS_SSH_KNOWN_HOSTS` (the trusted host-key line for the VPS)
- `GHCR_USERNAME`
- `GHCR_PULL_TOKEN` (a token with `read:packages` and `write:packages`; the
  main-only image publisher uses it to push, and CD uses it to pull)

Restrict the `production` environment's deployment branches to `main`. The CI
image boot job runs for pull requests without entering this environment; only
the separate publisher job enters it to push the booted image. CD's
`workflow_run` jobs also enter `production`; their workflow runs on the default
branch (`main`), while the trigger and resolve-job condition verify that the
completed CI run itself came from a push to `main`.

The workflow uses the commit SHA as the only release tag; nothing publishes
`latest`, so a rollback remains the immutable-image procedure above pointing at
an earlier SHA. Keep all runtime, database, Vault, and downstream credentials
in the VPS/Vault setup; never add them to GitHub Actions or the repository.

Before any host change, CD fetches `main` and requires the completed CI run's
SHA to still be its tip. It reads the running revision of each enabled tier
from `org.opencontainers.image.revision` and refuses a target that is already
running or older than that revision. To intentionally deploy an older release,
use the deliberate rollback procedure in #289; rerunning an old CI run is not
a rollback mechanism.
