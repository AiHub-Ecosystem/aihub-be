import { readFileSync } from 'node:fs';

describe('CD Cosign verification gate (#1839)', () => {
  it('installs pinned Cosign and verifies signature and SBOM attestation in cd.yml before deploy', () => {
    const cdContent = readFileSync('.github/workflows/cd.yml', 'utf8');
    const resolveStart = cdContent.indexOf('\n  resolve:');
    const deployStart = cdContent.indexOf('\n  deploy:', resolveStart);
    expect(resolveStart).toBeGreaterThanOrEqual(0);
    expect(deployStart).toBeGreaterThan(resolveStart);
    const resolveJob = cdContent.slice(resolveStart, deployStart);

    // Pinned Cosign installation
    expect(resolveJob).toContain('Install Cosign 2.4.1');
    expect(resolveJob).toContain(
      'https://github.com/sigstore/cosign/releases/download/v2.4.1/cosign-linux-amd64',
    );
    expect(resolveJob).toContain(
      '8b24b946dd5809c6bd93de08033bcf6bc0ed7d336b7785787c080f574b89249b',
    );

    // Cryptographic verification
    expect(resolveJob).toContain('cosign verify');
    expect(resolveJob).toContain('cosign verify-attestation');
    expect(resolveJob).toContain('--type spdxjson');
    expect(resolveJob).toContain(
      '--certificate-oidc-issuer https://token.actions.githubusercontent.com',
    );
    expect(resolveJob).toContain('.github/workflows/ci.yml@refs/heads/main');
  });

  it('documents pre-deploy Cosign verification gate in image-sbom-provenance.md and deploy-vps.md', () => {
    const sbomDoc = readFileSync(
      'docs/operations/image-sbom-provenance.md',
      'utf8',
    );
    expect(sbomDoc).toContain('cosign verify');
    expect(sbomDoc).toContain('cosign verify-attestation');
    expect(sbomDoc).toContain('cd.yml');

    const vpsDoc = readFileSync('docs/operations/deploy-vps.md', 'utf8');
    expect(vpsDoc).toContain('cosign verify');
    expect(vpsDoc).toContain('cosign verify-attestation');
    expect(vpsDoc).toContain('cd.yml');
  });
});
