import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

describe('Vault AppRole unattended login', () => {
  it('requires both AppRole credentials and mints a durable Secret ID', () => {
    const provision = readRepoFile('ops/vault/provision-runtime-secrets.mjs');

    expect(provision).toContain("'bind_secret_id=true'");
    expect(provision).toContain("'secret_id_ttl=0'");
    expect(provision).toContain("'secret_id_num_uses=0'");
    expect(provision).toContain('`secret_id_bound_cidrs=${agentCidr}`');
    expect(provision).toContain("'rate=12'");
    expect(provision).toContain("'interval=1m'");
    expect(provision).toContain("'vault-secret-id'");
  });

  it('mounts role ID and Secret ID only into the Agent', () => {
    const agentConfig = readRepoFile('ops/vault/agent/aihub-runtime.hcl');
    const compose = readRepoFile('docker-compose.production.yml');

    expect(agentConfig).toContain('role_id_file_path');
    expect(agentConfig).toContain('secret_id_file_path');
    expect(agentConfig).toContain(
      'remove_secret_id_file_after_reading = false',
    );
    expect(compose).toContain('VAULT_ROLE_ID_FILE');
    expect(compose).toContain('VAULT_SECRET_ID_FILE');
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
    // CD must not mint or install a Secret ID; it is provisioned by the operator.
    const cd = readRepoFile('.github/workflows/cd.yml');

    expect(cd).not.toContain('single-use');
    expect(cd).not.toContain('fresh AppRole secret_id');
  });
});
