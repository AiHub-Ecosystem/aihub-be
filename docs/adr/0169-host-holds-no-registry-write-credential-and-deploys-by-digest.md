# ADR-0169: The host holds no registry write credential and CD deploys by digest

- Status: Accepted
- Date: 2026-11-16
- Related issue: [#366](https://github.com/AiHub-Ecosystem/aihub-be/issues/366)
- Related: [ADR-0064](0064-ci-publishes-the-image-it-booted.md), [ADR-0077](0077-production-secrets-only-reach-main-image-publisher.md), [#314](https://github.com/AiHub-Ecosystem/aihub-be/issues/314), [#115](https://github.com/AiHub-Ecosystem/aihub-be/issues/115)
- Amends: [ADR-0064](0064-ci-publishes-the-image-it-booted.md) (CD deploys the digest, not the sha tag), [ADR-0077](0077-production-secrets-only-reach-main-image-publisher.md) (CD no longer uses the publisher's credential)

## Context

`GHCR_PULL_TOKEN` carries `read:packages` and `write:packages`. The publisher
pushed with it, and CD used it to read the registry and to `docker login` the
production host. Anyone who is root there, including every account with Docker
access, could read it and push images. The CD logout step was
`continue-on-error`, so a successful run did not show that the login was gone.

CD also checked that the registry's digest for `:<sha>` matched CI, then deployed
`...:<sha>` by tag. A tag overwritten after the check, or before a later
recreate or rollback, deployed an image CI never booted.

## Decision

Two credentials, split by what each can do:

- `GHCR_READ_TOKEN` (`read:packages`) is the only registry credential CD reads.
  It reads the registry digest in `Resolve image` and logs the host in for the
  pull.
- `GHCR_PULL_TOKEN` (write-capable, historical name) is used by the CI publisher
  job alone. CD and the host never receive it.

CD hands the host `AIHUB_IMAGE=ghcr.io/aihub-ecosystem/aihub-be@sha256:<digest>`,
the digest CI published and CD already verified with Cosign. The host helper
rejects any other form. A digest names no commit, so CD passes the revision as
`AIHUB_REVISION` where the helper compares the running revision with the target.

The helper records the image digest of each release as the eighth column of
`releases.tsv` and rolls back by it. A release recorded before the column
existed resolves the digest of the image its retained container ran; a release
with neither is refused rather than pulled by tag.

The CD logout step no longer carries `continue-on-error`, so a login left on the
host fails the run. The credential that could be left is read-only.

## Blocker: publishing with `GITHUB_TOKEN`

Publishing with a job-scoped `GITHUB_TOKEN` and `packages: write` needs the
organization package setting "Allow GitHub Actions to create and update
packages" for this repository. That setting is off and belongs to an
organization admin; no change in this repository can turn it on. Until it is on,
the approved least-privilege fallback is the one above: the write-capable token
stays confined to the main-only publisher job in the `production` environment,
and it never reaches CD, the host, or a pull request run. Enabling the setting
remains the way to remove that token, and replaces the fallback when done.

## Consequences

- CD fails until the `production` environment has a `GHCR_READ_TOKEN` secret.
  It does not fall back to `GHCR_PULL_TOKEN`.
- A tag repointed after CI's check cannot change what runs, and a rollback pulls
  the digest that release ran.
- `releases.tsv` rows written before this change have seven columns. They keep
  working through the retained-container fallback.
- The host holding no login after a deploy was not observed by this change. An
  operator checks it once on the host (`docs/operations/deploy-vps.md`).
