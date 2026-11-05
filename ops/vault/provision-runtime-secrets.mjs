import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { validatePgBouncerBundle } from './pgbouncer-budget.mjs';

const environment = process.env.AIHUB_VAULT_ENVIRONMENT;
const credentialsDirectory = process.env.AIHUB_VAULT_CREDENTIALS_DIR;
const allowedEnvironments = new Set(['development', 'staging', 'production']);

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`Vault provisioning failed: ${message}`);
  process.exit(1);
}

if (process.env.AIHUB_VAULT_PROVISION_ALLOW !== 'true') {
  fail(
    'set AIHUB_VAULT_PROVISION_ALLOW=true for this explicit operator action',
  );
}

if (environment === undefined || !allowedEnvironments.has(environment)) {
  fail('AIHUB_VAULT_ENVIRONMENT must be development, staging, or production');
}

if (
  credentialsDirectory === undefined ||
  credentialsDirectory.trim().length === 0
) {
  fail('AIHUB_VAULT_CREDENTIALS_DIR is required');
}

// The Agent logs in unattended, so it authenticates with role_id alone. That
// requires bind_secret_id=false, and Vault then still requires a constraint:
// bound_cidr_list restricts the login to the deployment network.
//
// This must be the address Vault records as the request source, not the Agent
// container's IP. The Agent and Vault sit on different Docker networks, so
// Docker NATs every cross-network connection to the Vault-side gateway before
// Vault ever sees it. On the production host that is 172.16.2.1, and the
// Agent's own 172.16.7.x address is never observed by Vault. Read the value
// from a rejected login in the Vault audit log, not from `docker inspect`.
const agentCidr = process.env.AIHUB_VAULT_AGENT_CIDR?.trim();
if (agentCidr === undefined || !/^[\d./]+$/.test(agentCidr)) {
  fail(
    'AIHUB_VAULT_AGENT_CIDR must be the CIDR Vault records as the login source, for example 172.16.2.1/32',
  );
}

/** @param {string[]} args @param {string} label @returns {string} */
function runVault(args, label) {
  const result = spawnSync('vault', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`Vault command failed: ${label}`);
  }
  return result.stdout;
}

/** @param {string} fileName @param {string[]} keys @param {string[]} [optionalKeys] @returns {string} */
function readBundle(fileName, keys, optionalKeys = []) {
  const path = join(credentialsDirectory, fileName);
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`credential bundle cannot be read: ${fileName}`);
  }

  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !keys.includes(key) && !optionalKeys.includes(key),
    ) ||
    keys.some(
      (key) => typeof value[key] !== 'string' || value[key].trim().length === 0,
    ) ||
    optionalKeys.some(
      (key) =>
        value[key] !== undefined &&
        (typeof value[key] !== 'string' || value[key].trim().length === 0),
    )
  ) {
    fail(`credential bundle has an invalid schema: ${fileName}`);
  }

  return path;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const mounts = runVault(['auth', 'list', '-format=json'], 'auth list');
/** @type {unknown} */
let authMounts;
try {
  authMounts = JSON.parse(mounts);
} catch {
  fail('Vault auth list did not return JSON');
}
if (!isRecord(authMounts) || authMounts['approle/'] === undefined) {
  fail('auth/approle is not enabled; enable it in an operator session first');
}

const policyName = `aihub-${environment}-runtime`;
const policyPath = join(
  process.cwd(),
  'ops',
  'vault',
  'policies',
  `${policyName}.hcl`,
);
runVault(['policy', 'write', policyName, policyPath], 'policy write');

runVault(
  [
    'write',
    `auth/approle/role/${policyName}`,
    `token_policies=${policyName}`,
    'token_type=service',
    'secret_id_ttl=10m',
    'secret_id_num_uses=1',
    'token_ttl=1h',
    'token_max_ttl=24h',
    // bind_secret_id=false is what makes the Agent durable: without a
    // secret_id there is nothing to expire or burn, so the token renews until
    // it is revoked instead of dying at token_max_ttl. The operator still
    // mints a short-lived one-use secret_id for hands-on sessions. Vault
    // requires a constraint when bind_secret_id is off, so the deployment
    // network is bound at login time instead.
    'bind_secret_id=false',
    `bound_cidr_list=${agentCidr}`,
  ],
  'AppRole provision',
);

/** @type {Array<[string, string[], string, string[]?]>} */
const bundles = [
  ['ai-speaking.json', ['client_id', 'secret_key'], 'ai-speaking'],
  ['ai-writing.json', ['token'], 'ai-writing'],
  ['resend.json', ['api_key'], 'resend'],
  ['user-access-jwt.json', ['private_key_pem', 'key_id'], 'user-access-jwt'],
  ['seaweedfs.json', ['access_key_id', 'secret_access_key'], 'seaweedfs'],
  [
    'database.json',
    [
      'url',
      'sandbox_url',
      'sandbox_control_plane_read_url',
      'email_send_budget_url',
    ],
    'database',
    [
      'pooler_url',
      'sandbox_pooler_url',
      'control_plane_pooler_url',
      'sandbox_control_plane_pooler_url',
      'control_plane_read_pooler_url',
      'sandbox_control_plane_read_pooler_url',
      'email_send_budget_pooler_url',
      'sandbox_email_send_budget_pooler_url',
    ],
  ],
  ['redis.json', ['url', 'sandbox_url', 'email_send_rate_url'], 'redis'],
  [
    'sandbox-assertion.json',
    ['private_key_pem', 'key_id'],
    'sandbox-assertion',
  ],
  ['email-outbox.json', ['current_key_id', 'keys'], 'email-outbox'],
  ['web-session.json', ['client_secret'], 'web-session'],
  ['auth-mfa.json', ['current_key_id', 'keys'], 'auth-mfa'],
];

for (const [fileName, keys, bundleName, optionalKeys = []] of bundles) {
  const path = readBundle(fileName, keys, optionalKeys);
  runVault(
    ['kv', 'put', `secret/aihub/${environment}/${bundleName}`, `@${path}`],
    `KV bundle write (${bundleName})`,
  );
}

const poolerBundlePath = join(credentialsDirectory, 'database-pooler.json');
if (existsSync(poolerBundlePath)) {
  /** @type {unknown} */
  let poolerBundle;
  try {
    poolerBundle = JSON.parse(readFileSync(poolerBundlePath, 'utf8'));
  } catch {
    fail('credential bundle cannot be read: database-pooler.json');
  }
  try {
    const runtimePoolMax = [
      'AIHUB_POSTGRES_POOL_MAX_RUNTIME',
      'AIHUB_POSTGRES_POOL_MAX_CONTROL_PLANE',
      'AIHUB_POSTGRES_POOL_MAX_CONTROL_PLANE_READ',
      'AIHUB_POSTGRES_POOL_MAX_EMAIL_DAILY_BUDGET',
    ].reduce((sum, name) => {
      const value = Number(process.env[name]);
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} is required when provisioning PgBouncer`);
      }
      return sum + value;
    }, 0);
    validatePgBouncerBundle(poolerBundle, runtimePoolMax);
  } catch (error) {
    fail(
      `credential bundle has an invalid schema: database-pooler.json (${error instanceof Error ? error.message : 'invalid budget'})`,
    );
  }
  runVault(
    [
      'kv',
      'put',
      `secret/aihub/${environment}/database-pooler`,
      `@${poolerBundlePath}`,
    ],
    'KV bundle write (database-pooler)',
  );

  const poolerPolicyName = `aihub-${environment}-pgbouncer`;
  const poolerPolicyPath = join(
    process.cwd(),
    'ops',
    'vault',
    'policies',
    `${poolerPolicyName}.hcl`,
  );
  runVault(
    ['policy', 'write', poolerPolicyName, poolerPolicyPath],
    'PgBouncer policy write',
  );
  runVault(
    [
      'write',
      `auth/approle/role/${poolerPolicyName}`,
      `token_policies=${poolerPolicyName}`,
      'token_type=service',
      'secret_id_ttl=10m',
      'secret_id_num_uses=1',
      'token_ttl=1h',
      'token_max_ttl=24h',
      'bind_secret_id=false',
      `bound_cidr_list=${agentCidr}`,
    ],
    'PgBouncer AppRole provision',
  );
}

console.log(`Vault provisioning completed for ${environment}`);
