# CI image boot and publish (issues #119, #202)

The `Image boot` job in CI builds the production image from the real
Dockerfile, starts it with throwaway configuration, and waits for the image's
own health check to report healthy. CD runs only after CI succeeds, so a
release that cannot start is blocked before it reaches the VPS instead of
taking production down after `up -d`.

It answers one question: **does this artifact start.**

When the boot passes, the same image is pushed to GHCR under the commit sha, and
CD deploys that image rather than building one again
([ADR-0064](../adr/0064-ci-publishes-the-image-it-booted.md)). The image that
reaches production is therefore the image this job started.

## Run it locally

```sh
docker build -t aihub:image-boot .
bash scripts/image-boot-check.sh aihub:image-boot
```

The script generates the configuration, runs the container detached, polls
its health every 2 seconds for up to 90 (`BOOT_CHECK_TIMEOUT_SECONDS`
overrides), and on failure prints the last 100 lines of the container log,
which names the provider or module that could not be built. It works from
Git Bash on Windows as well as in CI.

## Minimum configuration to boot

`scripts/ci-boot-config.cjs` is the source of truth. It writes:

- `runtime-secrets.json` and `connection-secrets.json`, in the shapes the
  Vault templates under `ops/vault/templates` render, mounted read-only at
  `/run/secrets/aihub` as in production;
- `boot.env`, the non-secret variables `docker-compose.production.yml` sets
  for the app.

Every value is fake: hosts use the reserved `.invalid` domain, and the
User Access JWT (RSA) and sandbox assertion (EC P-256) signing keys are minted
on each run, so no private key is committed. The production image refuses the
environment secret source, so the files are required, exactly as on the VPS.

`scripts/ci-boot-config.spec.ts` loads the generated secret files through the
real runtime secret provider and connection loader, and checks that
`boot.env` sets exactly the variables `docker-compose.production.yml` sets for
the app. So a newly required secret, or a variable added to production, fails
`pnpm verify` before the Docker job does. A new _validation rule_ on an
existing non-secret value is caught only by the boot itself.

## What a green check proves

- The image builds from this commit, including its pinned Node version.
- The container's entrypoint loads runtime secrets and connection settings
  the way production does.
- The full dependency-injection graph assembles: every provider resolves and
  every module registers.
- The server listens and answers `/health` under the image's own Node.

## What it does not prove

- **No database, Redis, SeaweedFS, or downstream connectivity.** Connections
  are opened lazily and the check provides none; the connection URLs point at
  unresolvable hosts. `/health` is static and does not probe them.
- **No migrations** are run or checked here; the database lane covers SQL.
- **Real secret values:** the shapes match the Vault templates, but not what
  Vault actually holds.
- **Behavior under load, or any request beyond `/health`.** It is not an
  integration suite and should not become one.
- **That the deployment survives.** An image that boots can still fail its
  release, for reasons the boot check does not reach. That is what the deploy
  job's health gate is for.

## The published image and its digest

CI pushes `ghcr.io/aihub-be:<commit sha>` only for pushes to `main`, and only
after the boot passes. Pull requests run the identical build and boot check and
push nothing.

The push authenticates with the `production` environment's `GHCR_USERNAME` and
`GHCR_PULL_TOKEN`, the same credentials CD uses. The job enters that
environment for the secret alone; it declares no reviewers and no branch
policy. `GITHUB_TOKEN` is deliberately not used: the package belongs to the
organization, and the workflow token may write to it only once "Allow GitHub
Actions to create and update packages" is enabled in the package settings.
That setting is off, so `GITHUB_TOKEN` fails with
`denied: permission_denied: write_package`. Turning it on is the better
long-term answer, because the workflow token rotates itself. Despite its name,
`GHCR_PULL_TOKEN` is the token that writes here; it is named for reading
because CD only ever read with it.

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
