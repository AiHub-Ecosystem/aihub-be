# Production image SBOM and provenance

This runbook records how the production Docker image's Software Bill of Materials (SBOM) and Sigstore provenance are produced, published, and verified (issue #1814, ADR-0064).

## Where the SBOM is produced

CI builds and boots the production image, then the `publish-image` job (`.github/workflows/ci.yml`, `main` push only, `production` environment) pushes the booted image to GHCR and generates an SPDX JSON SBOM for that image digest with Syft (`anchore/sbom-action`). The SBOM is:

- uploaded as a workflow artifact (`image-sbom`) for the CI run containing both `image-sbom.spdx.json` and its offline Cosign signature bundle `image-sbom.spdx.json.bundle`;
- attached to the image in the registry as an in-toto SPDX attestation, signed keylessly with cosign/Sigstore and bound to the image digest; and
- scanned with Grype (`anchore/scan-action`) before the release is considered complete.

CD (`.github/workflows/cd.yml`) resolves the image by digest and never rebuilds it (ADR-0064). The SBOM follows the image digest, so an operator can start from the deployed digest and find the same attestation.

## Vulnerability threshold

The release scan fails when Grype finds an actionable (fixed) vulnerability at or above **High** severity (`--only-fixed --fail-on high`). The SBOM is still generated and attached before the gate so all findings are inspectable from the registry artifact.

Threshold decision (2026-11-09, #1814): fail on actionable (fixed) `high` and `critical` vulnerabilities (`--only-fixed --fail-on high`). Upstream OS vendor `(won't fix)` items remain visible in the SBOM and scan output but do not block publishing the booted image; raise or lower the cutoff here when operations agrees, and keep this dated note current.

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

The attestation payload contains the SPDX document and carries annotations (`org.opencontainers.image.source`, `org.opencontainers.image.revision`, `sbom.spdx.location`).

### Verifying the SBOM artifact offline (outside registry)

From the downloaded `image-sbom` CI workflow artifact:

```bash
cosign verify-blob image-sbom.spdx.json \
  --bundle image-sbom.spdx.json.bundle \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp 'https://github.com/AiHub-Ecosystem/aihub-be/.github/workflows/ci.yml@refs/heads/main'
```

## Related

- [ADR-0064: CI publishes the image it booted](../adr/0064-ci-publishes-the-image-it-booted.md)
- [Container Image Vulnerability Scanning](image-vulnerability-scanning.md)
- [#1814](https://github.com/AiHub-Ecosystem/aihub-be/issues/1814) Supply chain: generate, sign, and publish an SBOM for the production Docker image
- [#1662](https://github.com/AiHub-Ecosystem/aihub-be/issues/1662) Dependabot automation and risk-grouped approve/merge
