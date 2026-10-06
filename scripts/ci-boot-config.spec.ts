import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import {
  loadRuntimeConfiguration,
  runtimeEnvironmentMetadata,
} from '@/config/runtime-configuration';
import { ConfiguredRuntimeSecretProvider } from '@/modules/secrets/infrastructure/configured-runtime-secret.provider';
import { loadRuntimeConnectionEnvironment } from '@/modules/secrets/infrastructure/runtime-connection.environment';
import { writeBootConfig } from './ci-boot-config.cjs';

const PRODUCTION_DEPLOYMENT_ONLY_VARIABLES = new Set([
  'AIHUB_IMAGE',
  'AIHUB_SANDBOX_ENABLED',
  'AIHUB_SANDBOX_APP_PORT',
  'AIHUB_DATABASE_NETWORK',
  'AIHUB_APP_PORT',
  'CUSTOMER_WEB_SANDBOX_BASE_URL',
  'SEAWEEDFS_SANDBOX_USER_ASSET_BUCKET',
  'SEAWEEDFS_SANDBOX_AUDIO_ASSET_BUCKET',
  'VAULT_IMAGE',
  'VAULT_ADDR',
  'VAULT_CA_CERT_FILE',
  'VAULT_ROLE_ID_FILE',
  'AIHUB_RUNTIME_SECRETS_HOST_DIR',
]);

function readBootEnv(directory: string): NodeJS.Dict<string> {
  return parseEnv(readFileSync(join(directory, 'boot.env'), 'utf8'));
}

// The variable names under the production compose file's app environment
// anchor, read line by line: the anchor is flat `NAME: value` pairs.
function productionAppEnvironmentNames(): string[] {
  const lines = readFileSync('docker-compose.production.yml', 'utf8').split(
    /\r?\n/,
  );
  const start = lines.findIndex((line) => line.includes('&app-environment'));
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    const match = /^ {2}([A-Z][A-Z0-9_]*):/.exec(line);
    if (match?.[1] === undefined) {
      break;
    }
    names.push(match[1]);
  }
  return names;
}

describe('CI boot configuration', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aihub-boot-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  // The files are only worth generating if the application's own loaders
  // accept them the way the production image reads them: agent-file source,
  // production node environment.
  it('writes secrets the runtime secret provider accepts in production', () => {
    writeBootConfig(directory);
    const env = readBootEnv(directory);

    const provider = new ConfiguredRuntimeSecretProvider({
      nodeEnv: env.NODE_ENV,
      source: env.AIHUB_RUNTIME_SECRET_SOURCE,
      secretsFile: join(directory, 'runtime-secrets.json'),
      values: {},
    });

    expect(env.NODE_ENV).toBe('production');
    expect(provider.getSnapshot().userAccessJwt.privateKeyPem).toContain(
      'BEGIN PRIVATE KEY',
    );
  });

  it('writes connections the runtime connection loader accepts', () => {
    writeBootConfig(directory);
    const env: NodeJS.ProcessEnv = {
      ...readBootEnv(directory),
      AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: join(
        directory,
        'connection-secrets.json',
      ),
    };

    loadRuntimeConnectionEnvironment({ env });

    expect(() => loadRuntimeConfiguration(env)).not.toThrow();
    expect(env.DATABASE_URL).toMatch(/^postgres:\/\//);
    expect(env.REDIS_URL).toMatch(/^redis:\/\//);
    expect(env.AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY).toContain(
      'BEGIN PRIVATE KEY',
    );
  });

  // The secret loaders above cannot see the non-secret variables; this keeps
  // them in step with what production actually sets.
  it('sets exactly the variables production sets for the app', () => {
    writeBootConfig(directory);

    expect(Object.keys(readBootEnv(directory)).sort()).toEqual(
      productionAppEnvironmentNames().sort(),
    );
  });

  it('keeps the local example and production app environment covered by the schema', () => {
    const localExampleNames = Object.keys(
      parseEnv(readFileSync('.env.example', 'utf8')),
    );
    expect(localExampleNames).toEqual(
      expect.arrayContaining(Object.keys(runtimeEnvironmentMetadata)),
    );
    for (const name of productionAppEnvironmentNames()) {
      expect(runtimeEnvironmentMetadata).toHaveProperty(name);
    }
    const productionExampleNames = Object.keys(
      parseEnv(readFileSync('.env.production.example', 'utf8')),
    );
    for (const name of productionExampleNames) {
      expect(
        Object.prototype.hasOwnProperty.call(
          runtimeEnvironmentMetadata,
          name,
        ) || PRODUCTION_DEPLOYMENT_ONLY_VARIABLES.has(name),
      ).toBe(true);
    }
  });

  it('sets a valid Customer Web URL for production startup', () => {
    writeBootConfig(directory);

    expect(readBootEnv(directory).CUSTOMER_WEB_BASE_URL).toBe(
      'https://customer.ci-boot.invalid',
    );
  });

  it('maps the sandbox Customer Web URL only to the sandbox app', () => {
    const compose = readFileSync('docker-compose.production.yml', 'utf8');
    const sandboxIndex = compose.indexOf('  app-sandbox:');
    const sandboxEnd = compose.indexOf('\nnetworks:', sandboxIndex);
    const sandboxService = compose.slice(sandboxIndex, sandboxEnd);

    expect(sandboxIndex).toBeGreaterThanOrEqual(0);
    expect(sandboxEnd).toBeGreaterThan(sandboxIndex);
    expect(sandboxService).toMatch(
      /CUSTOMER_WEB_BASE_URL:\s*\$\{CUSTOMER_WEB_SANDBOX_BASE_URL:-\}/,
    );
  });

  it('mints fresh keys on every run, so none is ever committed', () => {
    const keys = (): string[] => [
      readFileSync(join(directory, 'runtime-secrets.json'), 'utf8'),
      readFileSync(join(directory, 'connection-secrets.json'), 'utf8'),
    ];
    writeBootConfig(directory);
    const [firstRuntime, firstConnection] = keys();
    writeBootConfig(directory);
    const [secondRuntime, secondConnection] = keys();

    expect(secondRuntime).not.toBe(firstRuntime);
    expect(secondConnection).not.toBe(firstConnection);
  });
});
