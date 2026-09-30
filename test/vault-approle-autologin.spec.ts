import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

describe('Vault AppRole unattended login', () => {
  it('disables bind_secret_id so the Agent holds a durable credential', () => {
    const provision = readRepoFile('ops/vault/provision-runtime-secrets.mjs');

    expect(provision).toContain("'bind_secret_id=false'");
    expect(provision).toContain('`bound_cidr_list=${agentCidr}`');
    expect(provision).not.toContain('secret_id_bound_cidrs');
  });

  it('gives the Agent a role ID only, so nothing expires after login', () => {
    const agentConfig = readRepoFile('ops/vault/agent/aihub-runtime.hcl');
    const compose = readRepoFile('docker-compose.production.yml');

    expect(agentConfig).toContain('role_id_file_path');
    expect(agentConfig).not.toContain('secret_id_file_path');
    expect(compose).toContain('VAULT_ROLE_ID_FILE');
    expect(compose).not.toContain('VAULT_SECRET_ID_FILE');
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
    // bind_secret_id=false means the Agent re-authenticates by itself. A comment
    // telling the next operator to stage a SecretID by hand is how this comes
    // back, so the stale reasoning is pinned here rather than left in prose.
    const cd = readRepoFile('.github/workflows/cd.yml');

    expect(cd).not.toContain('single-use');
    expect(cd).not.toContain('fresh AppRole secret_id');
  });
});
