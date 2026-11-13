import { existsSync, readFileSync } from 'node:fs';

describe('container image vulnerability scanning (#331)', () => {
  it('defines a valid .grype.yaml ignore configuration file', () => {
    expect(existsSync('.grype.yaml')).toBe(true);
    const content = readFileSync('.grype.yaml', 'utf8');
    expect(content).toMatch(/^ignore:\s*(?:\[\])?$/m);
  });

  it('scans the booted image and operational support images in ci.yml before publishing', () => {
    const ciContent = readFileSync('.github/workflows/ci.yml', 'utf8');
    const start = ciContent.indexOf('\n  image:');
    const end = ciContent.indexOf('\n  publish-image:', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const imageJob = ciContent.slice(start, end);

    expect(imageJob).toContain(
      "docker image inspect --format '{{.Id}}' aihub:image-boot",
    );
    expect(imageJob).toContain(
      'docker build -t aihub-guard:scan -f ops/firewall/guard.Dockerfile scripts/ops/firewall',
    );
    expect(imageJob).toContain(
      "docker image inspect --format '{{.Id}}' aihub-guard:scan",
    );
    expect(imageJob).toContain(
      "docker image inspect --format '{{.Id}}' aihub-ssh-tunnel:scan",
    );
    expect(imageJob.match(/grype "docker:\$image_id"/g) ?? []).toHaveLength(6);
    expect(imageJob).toContain('aihub:image-boot');
    expect(imageJob).toContain('ops/firewall/guard.Dockerfile');
    expect(imageJob).toContain('ops/monitoring/ssh-tunnel.Dockerfile');
    expect(imageJob).toContain('--only-fixed');
    expect(imageJob).toContain('--fail-on high');
  });

  it('defines a scheduled production image scan workflow', () => {
    const path = '.github/workflows/production-image-scan.yml';
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf8');

    expect(content).toMatch(/cron:\s*['"]0 4 \* \* \*['"]/);
    expect(content).toContain('workflow_dispatch:');
    expect(content).toContain('grype');
    expect(content).toContain('--only-fixed');
    expect(content).toContain('--fail-on high');
    expect(content).toContain('gh run download');
    expect(content).toContain('image-digest');
    expect(content).toContain('image="ghcr.io/${GITHUB_REPOSITORY,,}@$digest"');
    expect(content).toContain('gh issue');
  });

  it('documents the base-image digest bump procedure and accepted CVE policy', () => {
    const docPath = 'docs/operations/image-vulnerability-scanning.md';
    expect(existsSync(docPath)).toBe(true);
    const content = readFileSync(docPath, 'utf8');
    expect(content).toContain('.grype.yaml');
    expect(content).toContain('digest');
    expect(content).toContain('--only-fixed');
    expect(content).toContain(
      'Grype does not enforce expiry; remove expired exceptions manually.',
    );
  });
});
