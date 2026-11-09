#!/usr/bin/env node
/**
 * Writes the DAST boot configuration: the throwaway configuration the image
 * boot check uses (scripts/ci/boot/ci-boot-config.cjs), with the connection secrets
 * repointed at the job's disposable PostgreSQL and Redis and the production
 * host set to the loopback name the scanner resolves.
 *
 *   node scripts/ci/dast/dast-boot-config.cjs <directory>
 *
 * Requires AIHUB_DAST_DATABASE_URL and AIHUB_DAST_REDIS_URL in the
 * environment. Every credential stays fake and minted per run; the only hosts
 * the scan target can name are the ones the job itself created, which is what
 * keeps the scan (#319) unable to reach Sandbox or Production.
 */

const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const { writeBootConfig } = require('../boot/ci-boot-config.cjs');
// The app resolves its request environment from the Host header's hostname
// (src/modules/identity/shared/presentation/request-environment.ts), so the
// scanner must use this exact name. The job adds it to the runner's
// /etc/hosts pointing at 127.0.0.1.
const DAST_PRODUCTION_HOST = 'dast.aihub.invalid';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Repoints every database and Redis URL at the disposable instances. The
 * shapes are what the Vault templates render; anything else fails here rather
 * than booting half-configured.
 *
 * @param {Record<string, unknown>} connections
 * @param {string} databaseUrl
 * @param {string} redisUrl
 */
function repointConnections(connections, databaseUrl, redisUrl) {
  const database = isRecord(connections.database)
    ? connections.database
    : undefined;
  if (!isRecord(database) || Object.keys(database).length === 0) {
    throw new Error('connection secrets carry no database URLs');
  }
  for (const key of Object.keys(database)) {
    database[key] = databaseUrl;
  }

  const redis = isRecord(connections.redis) ? connections.redis : undefined;
  if (
    !isRecord(redis) ||
    redis.url === undefined ||
    redis.sandbox_url === undefined ||
    redis.email_send_rate_url === undefined
  ) {
    throw new Error('connection secrets carry no Redis URLs');
  }
  redis.url = redisUrl;
  redis.sandbox_url = redisUrl;
  redis.email_send_rate_url = `${redisUrl}/2`;
}

function main() {
  const directory = process.argv[2];
  if (directory === undefined) {
    console.error(
      'usage: node scripts/ci/dast/dast-boot-config.cjs <directory>',
    );
    process.exit(2);
  }
  const databaseUrl = process.env.AIHUB_DAST_DATABASE_URL;
  const redisUrl = process.env.AIHUB_DAST_REDIS_URL;
  if (
    databaseUrl === undefined ||
    databaseUrl.length === 0 ||
    redisUrl === undefined ||
    redisUrl.length === 0
  ) {
    console.error(
      'AIHUB_DAST_DATABASE_URL and AIHUB_DAST_REDIS_URL are required',
    );
    process.exit(2);
  }

  writeBootConfig(directory);

  const connectionsPath = path.join(directory, 'connection-secrets.json');
  const connections = /** @type {unknown} */ (
    JSON.parse(readFileSync(connectionsPath, 'utf8'))
  );
  if (!isRecord(connections)) {
    throw new Error('connection secrets are not an object');
  }
  repointConnections(connections, databaseUrl, redisUrl);
  writeFileSync(connectionsPath, JSON.stringify(connections));

  const bootEnvPath = path.join(directory, 'boot.env');
  const bootEnv = readFileSync(bootEnvPath, 'utf8')
    .split('\n')
    .map((line) =>
      line.startsWith('AIHUB_PRODUCTION_HOST=')
        ? `AIHUB_PRODUCTION_HOST=${DAST_PRODUCTION_HOST}`
        : line,
    )
    .join('\n');
  writeFileSync(bootEnvPath, bootEnv);

  console.log(`dast-boot-config: wrote ${directory}`);
}

main();
