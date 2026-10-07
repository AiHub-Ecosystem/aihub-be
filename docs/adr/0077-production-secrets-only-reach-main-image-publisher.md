# ADR-0077: Production secrets only reach main image publisher

- Status: Accepted
- Date: 2026-10-07
- Related: [#314](https://github.com/AiHub-Ecosystem/aihub-be/issues/314), [ADR-0064](0064-ci-publishes-the-image-it-booted.md)

## Context

GitHub grants environment secrets to every step in a job that references that
environment. The CI image job ran for pull requests and declared the
`production` environment so its guarded push steps could read the GHCR
credential. A pull request controls its workflow file, so step-level conditions
did not protect that credential.

ADR-0064 also requires that CI publish the exact image it booted. Moving the
push into a separate job cannot rely on the previous runner's local Docker
daemon; rebuilding in the publisher would reintroduce artifact drift.

## Decision

The image job builds and boots on every CI run and has no production environment
or production-secret references. On a push to `main`, it saves the loaded image
to an artifact. A separate job runs only for pushes to `main`, downloads and
loads that image, and is the only CI job that enters `production` to push it.
The publisher records the registry manifest digest as before, and CD continues
to deploy only the digest recorded by CI.

The `production` environment allows deployments from `main` only. CD's
`workflow_run` jobs use the repository's default branch ref, currently `main`;
the CD trigger and resolve-job condition continue to check the upstream CI
event and branch explicitly.

The publisher keeps using `GHCR_PULL_TOKEN` because the organization package
does not currently grant `GITHUB_TOKEN` write access. A one-time pull request
check attempts to read an environment secret and reports only whether it is
empty; it never prints the secret value. That probe is removed after the check.

## Consequences

- Pull request workflows can build and boot without production secrets.
- The published image remains the exact image that passed the boot check.
- The image archive adds artifact storage and transfer time to main CI runs.
- The environment branch rule also applies to CD. If the repository's default
  branch changes from `main`, update the rule or CD will be blocked.
- Enabling organization package write access for `GITHUB_TOKEN` remains a
  separate follow-up that would remove the long-lived registry token.
