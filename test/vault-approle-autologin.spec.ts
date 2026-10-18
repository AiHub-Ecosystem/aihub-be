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

  it('keeps the Sandbox Agent and rendered directory separate from Production', () => {
    const compose = readRepoFile('docker-compose.production.yml');
    const sandboxAgent = compose.slice(
      compose.indexOf('  vault-agent-sandbox:'),
      compose.indexOf(
        '\n  migrate:',
        compose.indexOf('  vault-agent-sandbox:'),
      ),
    );

    expect(sandboxAgent).toContain('AIHUB_VAULT_ENVIRONMENT: sandbox');
    expect(sandboxAgent).toContain('VAULT_SANDBOX_ROLE_ID_FILE');
    expect(sandboxAgent).toContain('AIHUB_SANDBOX_RUNTIME_SECRETS_HOST_DIR');
    expect(sandboxAgent).not.toContain('AIHUB_RUNTIME_SECRETS_HOST_DIR');
  });

  it('mounts only the Sandbox directory into Sandbox consumers', () => {
    const compose = readRepoFile('docker-compose.production.yml');
    for (const serviceName of [
      'migrate-sandbox',
      'app-sandbox',
      'app-sandbox-slot-b',
    ]) {
      const start = compose.indexOf(`  ${serviceName}:`);
      const nextService = /\n  [a-z][a-z0-9-]*:\n/.exec(
        compose.slice(start + 3),
      );
      const end = nextService === null ? -1 : start + 3 + nextService.index;
      const service = compose.slice(start, end < 0 ? undefined : end);

      expect(start).toBeGreaterThanOrEqual(0);
      expect(service).toContain('AIHUB_SANDBOX_RUNTIME_SECRETS_HOST_DIR');
      expect(service).not.toContain('AIHUB_RUNTIME_SECRETS_HOST_DIR');
      expect(service).toContain('vault-agent-sandbox');
    }
  });

  it('limits runtime policies to their own tier', () => {
    const productionPolicy = readRepoFile(
      'ops/vault/policies/aihub-production-runtime.hcl',
    );
    const sandboxPolicy = readRepoFile(
      'ops/vault/policies/aihub-sandbox-runtime.hcl',
    );

    expect(productionPolicy).not.toContain('sandbox-assertion');
    expect(productionPolicy).not.toContain('sandbox/');
    expect(sandboxPolicy).toContain(
      'secret/data/aihub/sandbox/sandbox-assertion',
    );
    expect(sandboxPolicy).not.toContain('production/');
    expect(sandboxPolicy).not.toContain('*');
  });

  it('refuses root tokens and records the provisioned role ID privately', () => {
    const provision = readRepoFile('ops/vault/provision-runtime-secrets.mjs');

    expect(provision).toContain("runVault(['token', 'lookup', '-format=json']");
    expect(provision).toContain("policies?.includes('root')");
    expect(provision).toContain('tokenLookup.data?.ttl === 0');
    expect(provision).toContain("join(credentialsDirectory, 'vault-role-id')");
    expect(provision).toContain('chmodSync(roleIdPath, 0o600)');
  });

  it('validates Sandbox database and Redis endpoints before Vault writes', () => {
    const provision = readRepoFile('ops/vault/provision-runtime-secrets.mjs');

    expect(provision).toContain(
      "environment === 'sandbox' ? 'aihub_sandbox' : 'aihub'",
    );
    expect(provision).toContain("redisUrl.pathname !== '/1'");
    expect(provision).toContain("redisUrl.username === 'default'");
    expect(provision).toContain("redisUrl.searchParams.getAll('keyPrefix')");
    expect(provision).toContain("redisKeyPrefixes[0] !== 'aihub-sandbox:'");
    expect(provision.indexOf('const credentialBundles =')).toBeLessThan(
      provision.indexOf("runVault(['policy', 'write', policyName, policyPath]"),
    );
  });

  it('smokes the Sandbox role against every Production path', () => {
    const smoke = readRepoFile('scripts/ops/vault-smoke.mjs');

    expect(smoke).toContain("environment === 'sandbox'");
    expect(smoke).toContain('secret/data/aihub/production/${bundle}');
    expect(smoke).toContain('secret/data/aihub/production/sandbox-assertion');
    expect(smoke).toContain(
      "capabilities.stdout.trim().toLowerCase() !== 'deny'",
    );
  });

  it('checks each running Agent against its tier-specific host mounts', () => {
    const deployment = readRepoFile('scripts/ops/blue-green-host.sh');

    expect(deployment).toContain('check-vault-agent <production|sandbox>');
    expect(deployment).toContain(
      'AIHUB_VAULT_ENVIRONMENT=$expected_environment',
    );
    expect(deployment).toContain('$role_id_path /run/secrets/vault/role_id');
    expect(deployment).toContain('$secrets_path /run/secrets/aihub');
    expect(deployment).toContain('check_vault_agent sandbox');
    expect(deployment).toContain(
      'Production Vault Agent connection file contains Sandbox fields',
    );

    const cd = readRepoFile('.github/workflows/cd.yml');
    expect(cd).toContain(
      './scripts/ops/blue-green-host.sh prepare-sandbox-cutover',
    );
    expect(cd.indexOf('Prepare Sandbox Vault secret cutover')).toBeLessThan(
      cd.indexOf('Deploy Production and verify caller IP'),
    );
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
