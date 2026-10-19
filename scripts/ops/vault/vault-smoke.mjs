import { spawnSync } from 'node:child_process';
import process from 'node:process';

const environment = process.env.AIHUB_VAULT_ENVIRONMENT;
const allowedEnvironments = new Set(['development', 'staging', 'production']);

function fail(message) {
  console.error(`Vault smoke test failed: ${message}`);
  process.exit(1);
}

if (process.env.AIHUB_VAULT_SMOKE_ALLOW !== 'true') {
  fail('set AIHUB_VAULT_SMOKE_ALLOW=true to run this opt-in check');
}

if (process.env.AIHUB_VAULT_SMOKE_AUTH_METHOD !== 'approle') {
  fail('set AIHUB_VAULT_SMOKE_AUTH_METHOD=approle to prove AppRole provenance');
}

if (environment === undefined || !allowedEnvironments.has(environment)) {
  fail('AIHUB_VAULT_ENVIRONMENT must be development, staging, or production');
}

function runVault(args) {
  return spawnSync('vault', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

const lookup = runVault(['token', 'lookup', '-format=json']);
if (lookup.status !== 0) {
  fail('the Vault CLI could not authenticate the current session');
}

let lookupDocument;
try {
  lookupDocument = JSON.parse(lookup.stdout);
} catch {
  fail('the Vault token lookup did not return JSON');
}

const lookupData = lookupDocument.data ?? lookupDocument;
const policies = Array.isArray(lookupData.policies) ? lookupData.policies : [];
if (policies.includes('root') || lookupData.ttl === 0) {
  fail('refusing to run with a root or non-expiring token');
}

const requiredPaths = [
  `secret/aihub/${environment}/ai-speaking`,
  `secret/aihub/${environment}/ai-writing`,
  `secret/aihub/${environment}/user-access-jwt`,
  `secret/aihub/${environment}/resend`,
  `secret/aihub/${environment}/seaweedfs`,
  `secret/aihub/${environment}/database`,
  `secret/aihub/${environment}/redis`,
  `secret/aihub/${environment}/sandbox-assertion`,
  `secret/aihub/${environment}/auth-mfa`,
];

for (const path of requiredPaths) {
  const result = runVault(['kv', 'get', '-format=json', path]);
  if (result.status !== 0) {
    fail(`the runtime identity cannot read ${path}`);
  }

  const capabilities = runVault([
    'token',
    'capabilities',
    path.replace(/^secret\//, 'secret/data/'),
  ]);
  if (
    capabilities.status !== 0 ||
    capabilities.stdout.trim().toLowerCase() !== 'read'
  ) {
    fail(`the runtime identity has broader-than-read access to ${path}`);
  }
}

const metadataPath = `secret/aihub/${environment}/ai-speaking`;
const metadata = runVault([
  'kv',
  'metadata',
  'get',
  '-format=json',
  metadataPath,
]);
if (metadata.status === 0) {
  fail(
    'the runtime identity can read KV metadata; policy is broader than required',
  );
}

const unrelatedPath = `secret/data/aihub/${environment}/unrelated`;
const unrelatedCapabilities = runVault([
  'token',
  'capabilities',
  unrelatedPath,
]);
if (
  unrelatedCapabilities.status !== 0 ||
  unrelatedCapabilities.stdout.trim().toLowerCase() !== 'deny'
) {
  fail('the runtime identity can access an unrelated data path');
}

const unrelatedMetadataPath = `secret/metadata/aihub/${environment}/unrelated`;
const unrelatedMetadataCapabilities = runVault([
  'token',
  'capabilities',
  unrelatedMetadataPath,
]);
if (
  unrelatedMetadataCapabilities.status !== 0 ||
  unrelatedMetadataCapabilities.stdout.trim().toLowerCase() !== 'deny'
) {
  fail('the runtime identity can access unrelated KV metadata');
}

console.log(
  `Vault smoke test passed for ${environment}: required data paths readable, unrelated data denied, and metadata denied`,
);
