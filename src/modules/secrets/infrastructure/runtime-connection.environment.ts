import { readFileSync } from 'node:fs';

import { SANDBOX_REDIS_KEY_PREFIX } from '@/common/redis/redis-client.factory';

type RuntimeConnectionScope = 'production' | 'sandbox';
type RuntimeConnectionDocument = Readonly<Record<string, unknown>>;
type ReadFile = (path: string) => string;

export interface RuntimeConnectionEnvironmentOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly readFile?: ReadFile;
}

export class RuntimeConnectionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConnectionConfigurationError';
  }
}

/**
 * Loads connection and sandbox signing material rendered by Vault Agent.
 *
 * The existing typed runtime-secret provider owns downstream credentials. This
 * loader covers the process-level settings that are needed before Nest wiring
 * exists (database, Redis, and the sandbox assertion signer). Local development
 * remains compatible with the explicit .env source because an absent connection
 * file is a no-op.
 */
export function loadRuntimeConnectionEnvironment(
  options: RuntimeConnectionEnvironmentOptions,
): void {
  const env = options.env;
  const scope = resolveScope(env.AIHUB_RUNTIME_DATABASE_SCOPE);
  if (scope === 'production') {
    delete env.AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY;
    delete env.AIHUB_SANDBOX_ASSERTION_KID;
  }

  const path = env.AIHUB_RUNTIME_CONNECTION_SECRETS_FILE?.trim();
  if (path === undefined || path.length === 0) {
    return;
  }

  let raw: string;
  try {
    raw = (options.readFile ?? defaultReadFile)(path);
  } catch {
    throw configurationError('runtime connection secret file cannot be read');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configurationError(
      'runtime connection secret file is not valid JSON',
    );
  }

  const root = asRecord(parsed, 'runtime connection secret document');
  assertAllowedKeys(
    root,
    scope === 'sandbox'
      ? ['database', 'redis', 'sandbox-assertion']
      : ['database', 'redis'],
    'runtime connection secret document',
  );

  const database = asRecord(root.database, 'database runtime secret bundle');
  const redis = asRecord(root.redis, 'Redis runtime secret bundle');
  assertAllowedKeys(
    database,
    scope === 'sandbox'
      ? ['sandbox_url', 'sandbox_control_plane_read_url']
      : ['url'],
    'database runtime secret bundle',
  );
  assertAllowedKeys(
    redis,
    scope === 'sandbox' ? ['sandbox_url'] : ['url'],
    'Redis runtime secret bundle',
  );

  env.DATABASE_URL = requiredRecordString(
    database,
    scope === 'sandbox' ? 'sandbox_url' : 'url',
    scope === 'sandbox' ? 'sandbox database URL' : 'database URL',
  );
  env.CONTROL_PLANE_READ_DATABASE_URL =
    scope === 'sandbox'
      ? requiredRecordString(
          database,
          'sandbox_control_plane_read_url',
          'sandbox control-plane read URL',
        )
      : (env.CONTROL_PLANE_DATABASE_URL ?? env.DATABASE_URL);
  const redisUrl = requiredRecordString(
    redis,
    scope === 'sandbox' ? 'sandbox_url' : 'url',
    scope === 'sandbox' ? 'sandbox Redis URL' : 'Redis URL',
  );
  if (scope === 'sandbox') {
    assertSandboxRedisUrl(redisUrl);
  }
  env.REDIS_URL = redisUrl;

  if (scope !== 'sandbox') return;

  const assertion = asRecord(
    root['sandbox-assertion'],
    'sandbox assertion runtime secret bundle',
  );
  assertAllowedKeys(
    assertion,
    ['private_key_pem', 'key_id'],
    'sandbox assertion runtime secret bundle',
  );
  env.AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY = requiredRecordString(
    assertion,
    'private_key_pem',
    'sandbox assertion private key',
  );
  env.AIHUB_SANDBOX_ASSERTION_KID = requiredRecordString(
    assertion,
    'key_id',
    'sandbox assertion key id',
  );
}

function assertSandboxRedisUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError('sandbox Redis URL is invalid');
  }

  const keyPrefixes = url.searchParams.getAll('keyPrefix');
  if (
    url.pathname !== '/1' ||
    url.username.length === 0 ||
    url.username === 'default' ||
    keyPrefixes.length !== 1 ||
    keyPrefixes[0] !== SANDBOX_REDIS_KEY_PREFIX
  ) {
    throw configurationError(
      'sandbox Redis URL must use a dedicated user, database /1, and the Sandbox key namespace',
    );
  }
}

function resolveScope(value: string | undefined): RuntimeConnectionScope {
  const scope = value?.trim() || 'production';
  if (scope !== 'production' && scope !== 'sandbox') {
    throw configurationError('AIHUB_RUNTIME_DATABASE_SCOPE is invalid');
  }
  return scope;
}

function assertAllowedKeys(
  record: RuntimeConnectionDocument,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw configurationError(`${label} contains unexpected fields`);
  }
}

function requiredRecordString(
  record: RuntimeConnectionDocument,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw configurationError(
      `required runtime connection is missing: ${label}`,
    );
  }
  return value;
}

function asRecord(value: unknown, label: string): RuntimeConnectionDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw configurationError(`${label} has an invalid shape`);
  }
  return value as RuntimeConnectionDocument;
}

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function configurationError(
  message: string,
): RuntimeConnectionConfigurationError {
  return new RuntimeConnectionConfigurationError(message);
}
