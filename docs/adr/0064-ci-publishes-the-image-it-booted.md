# ADR-0064: CI publishes the image it booted; CD never rebuilds

- Status: Accepted
- Date: 2026-09-30

## Context

CI and CD both built the production image from the same Dockerfile and the
same commit. CI's `Image boot` lane started the result and waited for its own
health check, then discarded it without pushing. CD ran the same Dockerfile
again and pushed that second, never-booted build to GHCR, and the deploy job
pinned it. The artifact reaching production was the only artifact no lane had
ever started. The lane was not idle: commit `9d8245eb` failed it with
`Cannot find module '@opentelemetry/sdk-trace-base'`, so it catches real boot
failures - it just protected the build that got thrown away.

Nothing made the two builds identical by construction. The base image was
referenced by a mutable tag, so a repoint between the CI build and the CD build
yields two different images from one commit, and dependency resolution is a
second source of drift. A warm `type=gha` build cache masked both rather than
preventing them: the cache makes CD's rebuild cheap, and cheap looks like
correct.

## Decision

CI builds the image once, boots it, and pushes that same image only after the
boot check passes. CD stops building: it resolves the release from the commit
sha tag CI pushed, pulls it, and compares its digest against the digest CI
recorded for that sha. A mismatch fails the run before the VPS is touched.

The push is a separate `docker push` step after the boot check, not
`docker/build-push-action` with `push: true`. Buildx cannot both load an image
into the daemon and emit a manifest list, so a single action cannot boot what it
pushed. The manual step is the deliberate cost of keeping "the image CI booted"
and "the image CD ships" the same object.

The base image is referenced by digest, not by a mutable tag, so two builds of
one commit cannot differ by repointing it. A pinned digest does not receive
base-image security patches on its own; bump it when Node publishes a security
patch for the pinned version, or monthly, whichever comes first.

Publishing runs only for pushes to `main`. Pull requests still run the boot
check against a local image and push nothing. The credential is the same
`GHCR_PULL_TOKEN` CD already uses, reached through the `production`
environment, which declares no reviewers and no branch policy and so gates
nothing.

`GITHUB_TOKEN` would have been the better credential — it rotates itself and
carries the narrowest scope — but it cannot write this package. The package
belongs to the organization, and the workflow token may write to it only once
"Allow GitHub Actions to create and update packages" is enabled in the package
settings. It is not, and the first push after this change failed with
`denied: permission_denied: write_package`. The registry token is named for
reading because that is what CD used it for; it is the credential that can
write, and it should be renamed when it is next rotated. Enabling the package
setting is the better long-term answer and revives `GITHUB_TOKEN` with no
secret to manage.

## Consequences

- The artifact that reaches production is the artifact a lane proved starts.
- The base image digest goes stale between bumps, so the runtime image carries
  whatever the pinned Debian and Node versions carried at pin time.
- The push carries no build provenance or SBOM. Enabling those requires
  `build-push-action` with `provenance: true`, which cannot also load the image
  for the boot check; that trade is deferred to #115, which must decide whether
  to boot the pulled image instead.
- `latest` no longer moves as part of this change, and nothing republishes it,
  so it is frozen on whatever the pre-change CD last pushed. Compose resolves
  `AIHUB_IMAGE` to a SHA tag, so no deployment depends on it. #115 decides when,
  if ever, a release earns it.
- Sha tags are never deleted, so a rollback to an earlier release still pulls.
  Retention depth is #115's decision.
- An image that fails its boot check is never pushed. An image that boots but
  whose deployment fails is still on the registry under its sha tag, which is
  what a rollback needs.
- The workflow can no longer produce an image outside CI. A hotfix that needs an
  image built on a workstation has no supported path.
