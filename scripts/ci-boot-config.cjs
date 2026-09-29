#!/usr/bin/env node
/**
 * Writes the throwaway configuration the production image needs to boot, for
 * the CI image boot check (docs/operations/ci-boot-check.md).
 *
 *   node scripts/ci-boot-config.cjs <directory>
 *
 * Produces, in <directory>:
 * - runtime-secrets.json and connection-secrets.json, in the shapes the Vault
 *   templates under ops/vault/templates render, mounted read-only at
 *   /run/secrets/aihub as in production;
 * - boot.env, the non-secret variables docker-compose.production.yml sets for
 *   the app, for `docker run --env-file`.
 *
 * Every value is fake. Hosts use the reserved .invalid domain and nothing is
 * contacted at boot. The signing keys are minted on every run, so no private
 * key, fake or not, is ever committed. This file is the source of truth for
 * the minimum configuration a boot needs: when a loader starts requiring a new
 * value, scripts/ci-boot-config.spec.ts fails until it is added here.
 */

const { generateKeyPairSync } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SECRETS_MOUNT = '/run/secrets/aihub';
const FAKE = 'ci-boot-fake';

function privateKeyPem(type, options) {
  return generateKeyPairSync(type, options)
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
}

function runtimeSecrets() {
  return {
    'ai-speaking': { client_id: FAKE, secret_key: FAKE },
    'ai-writing': { token: FAKE },
    resend: { api_key: FAKE },
    'user-access-jwt': {
      private_key_pem: privateKeyPem('rsa', { modulusLength: 2048 }),
      key_id: FAKE,
    },
    seaweedfs: { access_key_id: FAKE, secret_access_key: FAKE },
  };
}

function connectionSecrets() {
  // Unresolvable on purpose: the boot opens no connection, and a check that
  // needed one would stop answering only "does this artifact start".
  const database = 'postgres://ci-boot:ci-boot@database.invalid:5432/aihub';
  const redis = 'redis://cache.invalid:6379';
  return {
    database: {
      url: database,
      sandbox_url: database,
      sandbox_control_plane_read_url: database,
    },
    redis: { url: redis, sandbox_url: redis },
    'sandbox-assertion': {
      private_key_pem: privateKeyPem('ec', { namedCurve: 'P-256' }),
      key_id: FAKE,
    },
  };
}

// Mirrors the app environment in docker-compose.production.yml.
const BOOT_ENVIRONMENT = {
  NODE_ENV: 'production',
  PORT: '3000',
  OTEL_SERVICE_NAME: 'aihub-be',
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
  AIHUB_ALLOW_UNAUTHENTICATED_DEV: 'false',
  AIHUB_RUNTIME_SECRET_SOURCE: 'agent-file',
  AIHUB_RUNTIME_SECRETS_FILE: `${SECRETS_MOUNT}/runtime-secrets.json`,
  AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: `${SECRETS_MOUNT}/connection-secrets.json`,
  AIHUB_RUNTIME_DATABASE_SCOPE: 'production',
  AIHUB_USER_ACCESS_ISSUER: 'https://api.ci-boot.invalid',
  AIHUB_PRODUCTION_HOST: 'api.ci-boot.invalid',
  AIHUB_STAGING_HOST: 'staging.ci-boot.invalid',
  AIHUB_DEVELOPMENT_HOST: 'development.ci-boot.invalid',
  AIHUB_SANDBOX_HOST: 'sandbox.ci-boot.invalid',
  AIHUB_SANDBOX_ORG_IDS: 'org_ci_boot',
  DOWNSTREAM_AI_WRITING_URL: 'http://writing.ci-boot.invalid',
  DOWNSTREAM_AI_SPEAKING_URL: 'http://speaking.ci-boot.invalid',
  RESEND_FROM: 'AIHUB <no-reply@ci-boot.invalid>',
  CUSTOMER_WEB_BASE_URL: 'https://customer.ci-boot.invalid',
};

function writeBootConfig(directory) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'runtime-secrets.json'),
    JSON.stringify(runtimeSecrets()),
  );
  writeFileSync(
    join(directory, 'connection-secrets.json'),
    JSON.stringify(connectionSecrets()),
  );
  writeFileSync(
    join(directory, 'boot.env'),
    Object.entries(BOOT_ENVIRONMENT)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')
      .concat('\n'),
  );
}

module.exports = { writeBootConfig };

if (require.main === module) {
  const directory = process.argv[2];
  if (directory === undefined) {
    console.error('usage: node scripts/ci-boot-config.cjs <directory>');
    process.exit(2);
  }
  writeBootConfig(directory);
}
