# Production image SBOM and provenance

This runbook records how the production Docker image's Software Bill of Materials (SBOM) and Sigstore provenance are produced, published, and verified (issue #1814, ADR-0064).

## Where the SBOM is produced

CI builds and boots the production image, then the `publish-image` job (`.github/workflows/ci.yml`, `main` push only, `production` environment) pushes the booted image to GHCR and generates an SPDX JSON SBOM for that image digest with Syft (`anchore/sbom-action`). The SBOM is:

- uploaded as a workflow artifact (`image-sbom`) for the CI run;
- attached to the image in the registry as an in-toto SPDX attestation, signed keylessly with cosign/Sigstore and bound to the image digest; and
- scanned with Grype (`anchore/scan-action`) before the release is considered complete.

CD (`.github/workflows/cd.yml`) resolves the image by digest and never rebuilds it (ADR-0064). The SBOM follows the image digest, so an operator can start from the deployed digest and find the same attestation.

## Vulnerability threshold

The release scan fails when Grype finds a vulnerability at or above **High** severity (`severity-cutoff: high`, fail on findings). The SBOM is still generated and attached before the gate so the findings are inspectable from the registry artifact.

Threshold decision (2026-11-09, #1814): fail on `high` and `critical`. `medium`/lower findings remain visible in the SBOM and scan output but do not block publishing the already-booted image record; raise or lower the cutoff here when operations agrees, and keep this dated note current.

## Finding the SBOM from a deployed image

From a deployed image reference or digest:

```bash
# Verify the image signature (keyless, GitHub Actions OIDC issuer).
cosign verify ghcr.io/aihub-ecosystem/aihub-be@sha256:<digest> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp 'https://github.com/AiHub-Ecosystem/aihub-be/.github/workflows/ci.yml@refs/heads/main'

# Verify and fetch the SPDX SBOM attestation bound to the same digest.
cosign verify-attestation ghcr.io/aihub-ecosystem/aihub-be@sha256:<digest> \
  --type spdxjson \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp 'https://github.com/AiHub-Ecosystem/aihub-be/.github/workflows/ci.yml@refs/heads/main'
```

The attestation payload contains the SPDX document. CI also records the digest and SBOM location in the `publish-image` job summary and uploads `image-sbom.spdx.json` as the `image-sbom` artifact.

## Related

- [ADR-0064: CI publishes the image it booted](../adr/0064-ci-publishes-the-image-it-booted.md)
- [#1814](https://github.com/AiHub-Ecosystem/aihub-be/issues/1814) Supply chain: generate, sign, and publish an SBOM for the production Docker image
- [#1662](https://github.com/AiHub-Ecosystem/aihub-be/issues/1662) Dependabot automation and risk-grouped approve/merge
