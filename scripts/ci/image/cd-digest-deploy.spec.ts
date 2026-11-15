import { readFileSync } from 'node:fs';

// #366: CD pulls with a read-only credential, deploys the digest CI published
// instead of a tag, and fails when it cannot remove the registry login from the
// host. The workflow is read as text; the host-side behaviour is pinned by
// test/ops/blue-green-*.spec.sh.

const workflow = readFileSync('.github/workflows/cd.yml', 'utf8');

function step(name: string, next: string): string {
  const start = workflow.indexOf(`      - name: ${name}`);
  const end = workflow.indexOf(`      - name: ${next}`);
  if (start < 0 || end < start) {
    throw new Error(`step ${name} not found`);
  }
  return workflow.slice(start, end);
}

describe('CD digest deploy and read-only registry credential (#366)', () => {
  it('never reads the write-capable publisher credential', () => {
    expect(workflow).not.toContain('GHCR_PULL_TOKEN');
  });

  it('logs in to GHCR with the read-only credential, in CD and on the host', () => {
    const resolveLogin = step('Log in to GHCR', 'Install Cosign 2.4.1');
    const hostLogin = step(
      'Log in to GHCR on VPS',
      'Pause and drain AIHUB host jobs',
    );

    expect(resolveLogin).toContain('secrets.GHCR_READ_TOKEN');
    expect(hostLogin).toContain('secrets.GHCR_READ_TOKEN');
  });

  it('hands the host the digest CI published, not the tag it checked', () => {
    const resolve = step(
      'Check the registry still holds the image CI booted',
      'Verify image signature and SBOM attestation (Cosign)',
    );

    expect(resolve).toContain('echo "image=${image_name}@${actual}"');
    expect(resolve).not.toContain('echo "image=$image"');
  });

  it('takes the target revision from the CI run, never from the image name', () => {
    expect(workflow).not.toMatch(/AIHUB_IMAGE##\*:/);
  });

  it('gives the host the revision where it decides on the target', () => {
    const production = step(
      'Deploy Production and verify caller IP',
      'Deploy Sandbox release and verify caller IP',
    );

    expect(production).toContain('AIHUB_REVISION=$revision_arg');
    expect(production).toContain(
      'AIHUB_REVISION=$revision_arg bash -se" <<\'REMOTE\'\n          set -euo pipefail\n          cd "$APP_DIR"\n          ./scripts/ops/blue-green/blue-green-host.sh resume production',
    );
    expect(production).toMatch(
      /AIHUB_REVISION=\$revision_arg bash -se" <<'REMOTE' \|\| true\n\s+set -euo pipefail\n\s+cd "\$APP_DIR"\n\s+\.\/scripts\/ops\/blue-green\/blue-green-host\.sh recover-gate/,
    );
  });

  it('fails the deploy when the host registry login cannot be removed', () => {
    const logout = step(
      'Log out of GHCR on VPS',
      'Close shared SSH connection',
    );

    expect(logout).toContain('sudo -n docker logout ghcr.io');
    expect(logout).not.toContain('continue-on-error');
  });
});
