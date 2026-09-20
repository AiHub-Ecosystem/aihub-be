import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const environment = process.env.AIHUB_VAULT_ENVIRONMENT;
const credentialsDirectory = process.env.AIHUB_VAULT_CREDENTIALS_DIR;
const allowedEnvironments = new Set(['development', 'staging', 'production']);

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

function readBundle(fileName, keys) {
  const path = join(credentialsDirectory, fileName);
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`credential bundle cannot be read: ${fileName}`);
  }

  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some(
      (key) => typeof value[key] !== 'string' || value[key].trim().length === 0,
    )
  ) {
    fail(`credential bundle has an invalid schema: ${fileName}`);
  }

  return path;
}

const mounts = runVault(['auth', 'list', '-format=json'], 'auth list');
let authMounts;
try {
  authMounts = JSON.parse(mounts);
} catch {
  fail('Vault auth list did not return JSON');
}
if (
  typeof authMounts !== 'object' ||
  authMounts === null ||
  authMounts['approle/'] === undefined
) {
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
  ],
  'AppRole provision',
);

const bundles = [
  ['ai-speaking.json', ['client_id', 'secret_key'], 'ai-speaking'],
  ['ai-writing.json', ['token'], 'ai-writing'],
  ['resend.json', ['api_key'], 'resend'],
  ['user-access-jwt.json', ['private_key_pem', 'key_id'], 'user-access-jwt'],
  ['seaweedfs.json', ['access_key_id', 'secret_access_key'], 'seaweedfs'],
  ['database.json', ['url', 'sandbox_url'], 'database'],
  ['redis.json', ['url', 'sandbox_url'], 'redis'],
  [
    'sandbox-assertion.json',
    ['private_key_pem', 'key_id'],
    'sandbox-assertion',
  ],
];

for (const [fileName, keys, bundleName] of bundles) {
  const path = readBundle(fileName, keys);
  runVault(
    ['kv', 'put', `secret/aihub/${environment}/${bundleName}`, `@${path}`],
    `KV bundle write (${bundleName})`,
  );
}

console.log(
  `Vault provisioning completed for ${environment}: policy, AppRole, and eight KV bundles updated`,
);
