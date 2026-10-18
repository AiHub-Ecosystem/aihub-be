import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const environment = process.env.AIHUB_VAULT_ENVIRONMENT;
const credentialsDirectory = process.env.AIHUB_VAULT_CREDENTIALS_DIR;
const allowedEnvironments = new Set([
  'development',
  'staging',
  'production',
  'sandbox',
]);

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
  fail(
    'AIHUB_VAULT_ENVIRONMENT must be development, staging, production, or sandbox',
  );
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

  return { path, value };
}

const bundles = [
  ['ai-speaking.json', ['client_id', 'secret_key'], 'ai-speaking'],
  ['ai-writing.json', ['token'], 'ai-writing'],
  ['resend.json', ['api_key'], 'resend'],
  ['user-access-jwt.json', ['private_key_pem', 'key_id'], 'user-access-jwt'],
  ['seaweedfs.json', ['access_key_id', 'secret_access_key'], 'seaweedfs'],
  [
    'database.json',
    environment === 'sandbox' ? ['url', 'control_plane_read_url'] : ['url'],
    'database',
  ],
  ['redis.json', ['url'], 'redis'],
  ['email-outbox.json', ['current_key_id', 'keys'], 'email-outbox'],
  ['web-session.json', ['client_secret'], 'web-session'],
  ['auth-mfa.json', ['current_key_id', 'keys'], 'auth-mfa'],
];
if (environment === 'sandbox') {
  bundles.push([
    'sandbox-assertion.json',
    ['private_key_pem', 'key_id'],
    'sandbox-assertion',
  ]);
}

let tokenLookup;
try {
  tokenLookup = JSON.parse(
    runVault(['token', 'lookup', '-format=json'], 'token lookup'),
  );
} catch {
  fail('Vault token lookup did not return JSON');
}
if (tokenLookup.data?.policies?.includes('root')) {
  fail('use a non-root Vault operator token for provisioning');
}
if (tokenLookup.data?.ttl === 0) {
  fail('use an expiring non-root Vault operator token for provisioning');
}

const credentialBundles = bundles.map(([fileName, keys, bundleName]) => ({
  bundleName,
  ...readBundle(fileName, keys),
}));

function connectionUrl(value, label, protocols) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be a valid URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    fail(`${label} has an unsupported URL scheme`);
  }
  return parsed;
}

function databaseName(url, label) {
  try {
    return decodeURIComponent(url.pathname.slice(1));
  } catch {
    fail(`${label} has an invalid database path`);
  }
}

if (environment === 'production' || environment === 'sandbox') {
  const database = credentialBundles.find(
    ({ bundleName }) => bundleName === 'database',
  ).value;
  const redis = credentialBundles.find(
    ({ bundleName }) => bundleName === 'redis',
  ).value;
  const databaseUrl = connectionUrl(database.url, 'database.json url', [
    'postgres:',
    'postgresql:',
  ]);
  const redisUrl = connectionUrl(redis.url, 'redis.json url', [
    'redis:',
    'rediss:',
  ]);
  const expectedDatabase =
    environment === 'sandbox' ? 'aihub_sandbox' : 'aihub';
  if (databaseName(databaseUrl, 'database.json url') !== expectedDatabase) {
    fail(`database.json url must target ${expectedDatabase}`);
  }
  if (environment === 'sandbox') {
    const redisKeyPrefixes = redisUrl.searchParams.getAll('keyPrefix');
    const controlPlaneUrl = connectionUrl(
      database.control_plane_read_url,
      'database.json control_plane_read_url',
      ['postgres:', 'postgresql:'],
    );
    if (
      databaseName(controlPlaneUrl, 'database.json control_plane_read_url') !==
        'aihub' ||
      databaseUrl.username.length === 0 ||
      controlPlaneUrl.username.length === 0 ||
      controlPlaneUrl.username === databaseUrl.username
    ) {
      fail(
        'Sandbox control_plane_read_url must use a distinct restricted Production reader',
      );
    }
    if (
      redisUrl.pathname !== '/1' ||
      redisUrl.username.length === 0 ||
      redisUrl.username === 'default' ||
      redisKeyPrefixes.length !== 1 ||
      redisKeyPrefixes[0] !== 'aihub-sandbox:'
    ) {
      fail(
        'Sandbox redis.json url must use database /1, a dedicated ACL username, and the aihub-sandbox key namespace',
      );
    }
  }
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
    // bind_secret_id=false is what makes the Agent durable: without a
    // secret_id there is nothing to expire or burn, so the token renews until
    // it is revoked instead of dying at token_max_ttl. Vault requires a
    // constraint when bind_secret_id is off, so the deployment network is
    // bound at login time instead.
    'bind_secret_id=false',
    `bound_cidr_list=${agentCidr}`,
  ],
  'AppRole provision',
);

const roleId = runVault(
  ['read', '-field=role_id', `auth/approle/role/${policyName}/role-id`],
  'AppRole role ID read',
).trim();
if (roleId.length === 0) {
  fail('Vault returned an empty AppRole role ID');
}
const roleIdPath = join(credentialsDirectory, 'vault-role-id');
writeFileSync(roleIdPath, `${roleId}\n`, { mode: 0o600 });
chmodSync(roleIdPath, 0o600);

for (const { path, bundleName } of credentialBundles) {
  runVault(
    ['kv', 'put', `secret/aihub/${environment}/${bundleName}`, `@${path}`],
    `KV bundle write (${bundleName})`,
  );
}

console.log(
  `Vault provisioning completed for ${environment}: policy, AppRole, role ID file, and ${bundles.length} KV bundles updated`,
);
