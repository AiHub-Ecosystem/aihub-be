# CI image boot, N-1 compatibility, and publish (issues #119, #202, #755)

The `Image boot` job in CI builds the production image from the real
Dockerfile, starts it with throwaway configuration, and waits for the image's
own health check to report healthy. CD runs only after CI succeeds, so a
release that cannot start is blocked before it reaches the VPS instead of
taking production down after `up -d`.

Before building the image, the job also renders `docker-compose.production.yml`
with the checked-in example environment and enables every profile before
checking all services, including inactive profiles and migration services, for
the required bounded `json-file` logging options. A service without the
configured log bounds fails the job.

The boot check answers **does this artifact start**. The same `Image boot` job
then runs the candidate's migrations, starts the current Production image
against the same isolated PostgreSQL and Redis services, and exercises
candidate writes through both images. CI publishes only after both checks pass.

## N-1 release compatibility

`scripts/ci/n-minus-one/previous-deployed-release.ts` selects the newest
completed CD run whose Production cutover and smoke step passed, even when a
later Sandbox step failed and left Production on the newer SHA. If any main CD
run is still active, the lookup fails closed; rerun CI after that deployment
settles. The gate pulls the immutable Production SHA tag from GHCR, migrates
the isolated database with the candidate image, and runs both images
concurrently against the same database and Redis endpoint. It fails if N-1
cannot start, cannot read candidate-written idempotency, audit, usage, or
email-outbox data, or returns a server error to those reads.

The HTTP probes also exercise shared API-key and JWKS cache reads, cache
freshness bounds, generation and revocation invalidation, idempotency retry
admission, authentication rate windows, monthly quota reconstruction from
durable usage, and concurrency acquisition/release. Redis endpoint changes are
classified as a held/drained cutover; a deliberately mismatched `/0` to `/1`
fixture passes through the same image-pair guard before shared-state writes and
records both image SHAs. The generated image configs are checked before writes.
The job summary names both image SHAs and records the accepted ADR-0121
zero-width-space Organization-name constraint exception when the old image
reaches it.

The generated boot configuration leaves ADR-0123's verification-password
setting off, as the approved rollout requires. This gate does not enable that
setting ahead of the Customer Web change. ADR-0122's mixed-poller account-wide
Resend circuit limitation is reported explicitly; this gate checks that N-1 can
decrypt and dispatch a candidate outbox request, but it does not claim
cross-version ownership of a provider-outage circuit.

The local HTTP writing and HTTPS Resend fixtures return deterministic
responses and never call external providers. The gate uses only fake secrets
and a throwaway database and Redis service. It does not flush Redis between
images; only the test Organization's quota counter is deleted to exercise the
documented durable-usage rebuild path.

When the boot passes on a push to `main`, CI saves that image as an artifact.
A separate, main-only publishing job loads and pushes the artifact to GHCR under
the commit sha; CD deploys that image rather than building one again
([ADR-0064](../adr/0064-ci-publishes-the-image-it-booted.md)). The image that
reaches production is therefore the image this job started. Pull requests run
the build and boot without entering the `production` environment or referencing
its secrets.

## Run it locally

```sh
docker build -t aihub:image-boot .
bash scripts/ci/image-boot-check.sh aihub:image-boot
```

The script generates the configuration, runs the container detached, polls
its health every 2 seconds for up to 90 (`BOOT_CHECK_TIMEOUT_SECONDS`
overrides), and on failure prints the last 100 lines of the container log,
which names the provider or module that could not be built. It works from
Git Bash on Windows as well as in CI.

## Minimum configuration to boot

`scripts/ci/ci-boot-config.cjs` is the source of truth. It writes:

- `runtime-secrets.json` and `connection-secrets.json`, in the shapes the
  Vault templates under `ops/vault/templates` render, mounted read-only at
  `/run/secrets/aihub` as in production;
- `boot.env`, the non-secret variables `docker-compose.production.yml` sets
  for the app.

Every value is fake: hosts use the reserved `.invalid` domain, and the
User Access JWT (RSA) and sandbox assertion (EC P-256) signing keys are minted
on each run, so no private key is committed. The production image refuses the
environment secret source, so the files are required, exactly as on the VPS.

`scripts/ci/ci-boot-config.spec.ts` loads the generated secret files through the
real runtime secret provider and connection loader, and checks that
`boot.env` sets exactly the variables `docker-compose.production.yml` sets for
the app. So a newly required secret, or a variable added to production, fails
`pnpm verify` before the Docker job does. A new _validation rule_ on an
existing non-secret value is caught only by the boot itself.

## What the boot check proves

- The image builds from this commit, including its pinned Node version.
- The container's entrypoint loads runtime secrets and connection settings
  the way production does.
- The full dependency-injection graph assembles: every provider resolves and
  every module registers.
- The server listens and answers `/health` under the image's own Node.

## Limits of the CI coverage

- **No production database, Redis, SeaweedFS, or downstream connectivity.**
  The N-1 check uses isolated PostgreSQL and Redis services plus local provider
  fixtures; it does not connect to production or external providers.
- **No production secrets:** the shapes match the Vault templates, but not what
  Vault actually holds.
- **Production traffic or sustained load.** The isolated N-1 probes exercise
  only the release cases listed above; they are not a load test.
- **That the deployment survives.** An image that boots can still fail its
  release, for reasons the boot check does not reach. That is what the deploy
  job's health gate is for.

## The published image and its digest

CI pushes `ghcr.io/aihub-be:<commit sha>` only for pushes to `main`, and only
after the boot and N-1 compatibility checks pass. Pull requests run the same
checks and push nothing.

The push authenticates with the `production` environment's `GHCR_USERNAME` and
`GHCR_PULL_TOKEN`, the same credentials CD uses. Only the push-only job enters
that environment; its deployment branch policy allows `main`. `GITHUB_TOKEN`
is deliberately not used: the package belongs to the organization, and the
workflow token may write to it only once "Allow GitHub Actions to create and
update packages" is enabled in the package settings. That setting is off, so
`GITHUB_TOKEN` fails with `denied: permission_denied: write_package`. Despite
its name, `GHCR_PULL_TOKEN` is write-capable and is the credential used to push
here; it is also used by CD to pull the image. The `Image boot` job uses its
read-only `GITHUB_TOKEN` permission to pull the previous private package for
the N-1 check; it does not receive the production environment or its secrets.

The boot job saves the loaded Docker image as `image-to-publish.tar` and uploads
it only on a push to `main`. The isolated publisher downloads and loads that
archive before authenticating, so no second build can drift from the image that
passed the boot check. Pull requests still boot a local image and publish
nothing.

The push is a separate `docker push` step rather than
`docker/build-push-action` with `push: true`. Buildx cannot both load an image
into a runner's daemon and emit the manifest list a push needs, so one action
cannot both boot the image and publish it. The manual push is what keeps "the
image CI booted" and "the image CD ships" the same object. It carries no build
provenance or SBOM; adding those requires a push that cannot also be booted
locally, which #115 still has to resolve.

CI records the manifest digest `docker push` reported, both in the run summary
and as an `image-digest` artifact. A `workflow_run` payload carries no job
outputs, so that artifact is how the digest reaches CD. The `Resolve image` job
reads it, asks the registry for the digest the sha tag currently holds, and
fails before touching the VPS when the two differ. That check is what catches a
sha tag being repointed after the fact. Both sides read the digest from the
registry with `docker buildx imagetools inspect` rather than scraping
`docker push` output, which interleaves a digest per layer; a local
`docker image inspect` would report the image ID, which is a different value
from the manifest digest the registry indexes by.

Sha tags are never deleted, so rolling back is a matter of pointing
`AIHUB_IMAGE` at an earlier sha. Retention depth is #115's decision.

`latest` is not published by either workflow any more, so it is frozen on
whatever the pre-change CD last pushed. Nothing deploys it: Compose resolves
`AIHUB_IMAGE` to a SHA tag. #115 defines when, if ever, a release earns it.

## Bumping the base image digest

The Dockerfile pins `node:22.23.2-bookworm-slim` by digest so two builds of one
commit cannot differ by a base image repoint. A pinned digest does not pick up
base image security patches on its own, so bump both `FROM` lines together:

```sh
docker buildx imagetools inspect node:22.23.2-bookworm-slim
```

Take the `Digest:` of the image index, not of a single platform manifest under
it. Bump when Node publishes a security patch for the pinned version, or
monthly, whichever comes first.
