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
});
