import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

// The provisioner needs a live Vault and an operator session, so unit tests
// cannot exercise its login. These assertions pin the deployment configuration
// itself, the same source-comparison pattern used by ci-push-paths.spec.ts and
// redis-email-send-rate-limiter.acl.spec.ts: credential or mount drift fails CI
// before an operator reaches the host.
describe('Vault AppRole unattended login', () => {
  it('requires a durable Secret ID in addition to the role ID and CIDR', () => {
    const provision = readRepoFile('ops/vault/provision-runtime-secrets.mjs');

    expect(provision).toContain("'bind_secret_id=true'");
    expect(provision).toContain("'secret_id_ttl=0'");
    expect(provision).toContain("'secret_id_num_uses=0'");
    expect(provision).toContain('`secret_id_bound_cidrs=${agentCidr}`');
    expect(provision).toContain('`role=${roleName}`');
    expect(provision).toContain("'rate=12'");
    expect(provision).toContain("'interval=1m'");
    expect(provision).toContain("'block_interval=1m'");
    expect(provision).toContain("'-wrap-ttl=5m'");
    expect(provision).toContain("'unwrap', '-format=json'");
    expect(provision).not.toContain("'bind_secret_id=false'");
  });

  it('gives the Agent both credential files through the secret channel', () => {
    const agentConfig = readRepoFile('ops/vault/agent/aihub-runtime.hcl');
    const poolerConfig = readRepoFile('ops/vault/agent/aihub-pgbouncer.hcl');
    const compose = readRepoFile('docker-compose.production.yml');

    expect(agentConfig).toContain('role_id_file_path');
    expect(agentConfig).toContain('secret_id_file_path');
    expect(poolerConfig).toContain('secret_id_file_path');
    expect(compose).toContain('VAULT_SECRET_ID_FILE');
    expect(compose).toContain('AIHUB_PGBOUNCER_VAULT_SECRET_ID_FILE');
  });

  it('never assigns a container address to the CIDR variable', () => {
    // The Agent and Vault are on separate Docker networks, so Vault records the
    // NATed gateway, not the container IP. Every doc that names a CIDR has to
    // name the NATed one, or the next operator copies the container IP straight
    // into the role and locks the Agent out of its own Vault. Prose may mention
    // the container address to explain why it is the wrong value; what must not
    // appear is that address assigned to the variable an operator sets.
    const assignments = [
      'ops/vault/README.md',
      'docs/operations/deploy-vps.md',
      'ops/vault/provision-runtime-secrets.mjs',
    ]
      .map(readRepoFile)
      .flatMap((contents) => contents.split('\n'))
      .filter((line) => /AIHUB_VAULT_AGENT_CIDR\s*=/.test(line));

    expect(assignments.length).toBeGreaterThan(0);
    for (const line of assignments) {
      expect(line).toMatch(/172\.16\.2\.1\/32/);
    }
  });

  it('never tells CD to recreate the Agent for a secret_id reason', () => {
    // A durable Secret ID means the Agent re-authenticates by itself. A comment
    // telling CD to mint one per deploy is how the obsolete #193 proposal comes
    // back, so the stale reasoning is pinned here rather than left in prose.
    const cd = readRepoFile('.github/workflows/cd.yml');

    expect(cd).not.toContain('single-use');
    expect(cd).not.toContain('fresh AppRole secret_id');
  });
});
