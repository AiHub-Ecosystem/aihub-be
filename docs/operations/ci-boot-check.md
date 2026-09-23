# CI image boot check (issue #119)

The `Image boot` job in CI builds the production image from the real
Dockerfile, starts it with throwaway configuration, and waits for the image's
own health check to report healthy. CD runs only after CI succeeds, so a
release that cannot start is blocked before it reaches the VPS instead of
taking production down after `up -d`.

It answers one question: **does this artifact start.**

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
- **Byte identity with the deployed image.** CD rebuilds from the same commit
  and shares this job's build cache, so it mostly reuses these layers, but it
  is a separate build. Shipping the exact image CI booted belongs to #115.
- **Behavior under load, or any request beyond `/health`.** It is not an
  integration suite and should not become one.
