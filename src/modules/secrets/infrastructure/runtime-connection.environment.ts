import {
  type SecretDocument,
  asDocument,
  assertOnlyFields,
  readUtf8File,
  requiredDocumentString,
} from '@/common/security/secret-document';

type RuntimeConnectionScope = 'production' | 'sandbox';
type ReadFile = (path: string) => string;

export interface RuntimeConnectionEnvironmentOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly target?: 'runtime' | 'operator';
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
 * loader covers the process-level settings needed before Nest wiring exists
 * (database, cache and email-rate Redis, and the sandbox assertion signer). Local
 * development remains compatible with the explicit .env source because an
 * absent connection file is a no-op.
 */
export function loadRuntimeConnectionEnvironment(
  options: RuntimeConnectionEnvironmentOptions,
): void {
  const env = options.env;
  const scope = resolveScope(env);
  if (scope === 'production') {
    delete env['AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY'];
    delete env['AIHUB_SANDBOX_ASSERTION_KID'];
  }

  const path = env['AIHUB_RUNTIME_CONNECTION_SECRETS_FILE']?.trim();
  if (path === undefined || path.length === 0) {
    return;
  }
  delete env['AIHUB_IDENTITY_CACHE_HMAC_KEY'];

  let raw: string;
  try {
    raw = (options.readFile ?? readUtf8File)(path);
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
    ['database', 'redis', 'sandbox-assertion'],
    'runtime connection secret document',
  );

  const database = asRecord(root['database'], 'database runtime secret bundle');
  const redis = asRecord(root['redis'], 'Redis runtime secret bundle');
  assertAllowedKeys(
    database,
    [
      'url',
      'sandbox_url',
      'sandbox_control_plane_read_url',
      'email_send_budget_url',
      'pooler_url',
      'sandbox_pooler_url',
      'control_plane_pooler_url',
      'sandbox_control_plane_pooler_url',
      'control_plane_read_pooler_url',
      'sandbox_control_plane_read_pooler_url',
      'email_send_budget_pooler_url',
      'sandbox_email_send_budget_pooler_url',
    ],
    'database runtime secret bundle',
  );
  assertAllowedKeys(
    redis,
    [
      'url',
      'sandbox_url',
      'email_send_rate_url',
      'identity_cache_hmac_key',
      'sandbox_identity_cache_hmac_key',
    ],
    'Redis runtime secret bundle',
  );

  const directDatabaseUrl = requiredRecordString(
    database,
    scope === 'sandbox' ? 'sandbox_url' : 'url',
    scope === 'sandbox' ? 'sandbox database URL' : 'database URL',
  );
  const directControlPlaneDatabaseUrl =
    env['CONTROL_PLANE_DATABASE_URL']?.trim() || directDatabaseUrl;
  const directControlPlaneReadDatabaseUrl =
    scope === 'sandbox'
      ? requiredRecordString(
          database,
          'sandbox_control_plane_read_url',
          'sandbox control-plane read URL',
        )
      : env['CONTROL_PLANE_READ_DATABASE_URL']?.trim() ||
        directControlPlaneDatabaseUrl;
  const directEmailBudgetDatabaseUrl = requiredRecordString(
    database,
    'email_send_budget_url',
    'shared email daily budget database URL',
  );
  const poolerEnabled = parsePoolerEnabled(
    env['AIHUB_DATABASE_POOLER_ENABLED'],
  );
  const usePooler = poolerEnabled && options.target !== 'operator';

  env['DATABASE_URL'] = usePooler
    ? requiredRecordString(
        database,
        scope === 'sandbox' ? 'sandbox_pooler_url' : 'pooler_url',
        'PgBouncer runtime URL',
      )
    : directDatabaseUrl;
  env['CONTROL_PLANE_DATABASE_URL'] = usePooler
    ? requiredRecordString(
        database,
        scope === 'sandbox'
          ? 'sandbox_control_plane_pooler_url'
          : 'control_plane_pooler_url',
        'PgBouncer control-plane URL',
      )
    : directControlPlaneDatabaseUrl;
  env['CONTROL_PLANE_READ_DATABASE_URL'] = usePooler
    ? requiredRecordString(
        database,
        scope === 'sandbox'
          ? 'sandbox_control_plane_read_pooler_url'
          : 'control_plane_read_pooler_url',
        'PgBouncer control-plane read URL',
      )
    : directControlPlaneReadDatabaseUrl;
  env['AIHUB_EMAIL_DAILY_BUDGET_DATABASE_URL'] = usePooler
    ? requiredRecordString(
        database,
        scope === 'sandbox'
          ? 'sandbox_email_send_budget_pooler_url'
          : 'email_send_budget_pooler_url',
        'PgBouncer email budget URL',
      )
    : directEmailBudgetDatabaseUrl;
  const emailWalPath = env['AIHUB_EMAIL_WAL_SECRETS_FILE']?.trim();
  if (emailWalPath) {
    let emailWalRaw: string;
    try {
      emailWalRaw = (options.readFile ?? readUtf8File)(emailWalPath);
    } catch {
      throw configurationError('email WAL secret file cannot be read');
    }
    let emailWalParsed: unknown;
    try {
      emailWalParsed = JSON.parse(emailWalRaw);
    } catch {
      throw configurationError('email WAL secret file is not valid JSON');
    }
    const emailWal = asRecord(emailWalParsed, 'email WAL secret bundle');
    assertAllowedKeys(
      emailWal,
      ['email_wal_url', 'sandbox_email_wal_url'],
      'email WAL secret bundle',
    );
    env['AIHUB_EMAIL_WAL_DATABASE_URL'] = requiredRecordString(
      emailWal,
      scope === 'sandbox' ? 'sandbox_email_wal_url' : 'email_wal_url',
      scope === 'sandbox' ? 'sandbox email WAL URL' : 'email WAL URL',
    );
  }
  env['REDIS_URL'] = requiredRecordString(
    redis,
    scope === 'sandbox' ? 'sandbox_url' : 'url',
    scope === 'sandbox' ? 'sandbox Redis URL' : 'Redis URL',
  );
  const identityCacheHmacKey = optionalRecordString(
    redis,
    scope === 'sandbox'
      ? 'sandbox_identity_cache_hmac_key'
      : 'identity_cache_hmac_key',
    'identity cache HMAC key',
  );
  if (identityCacheHmacKey !== undefined) {
    env['AIHUB_IDENTITY_CACHE_HMAC_KEY'] = identityCacheHmacKey;
  }
  env['AIHUB_EMAIL_SEND_RATE_REDIS_URL'] = requiredRecordString(
    redis,
    'email_send_rate_url',
    'email send rate Redis URL',
  );

  // shortcut: the shared JSON is parsed; upgrade once #351 splits Vault mounts.
  if (scope !== 'sandbox') return;

  const sandboxAssertion = root['sandbox-assertion'];
  if (sandboxAssertion === undefined) {
    return;
  }

  const assertion = asRecord(
    sandboxAssertion,
    'sandbox assertion runtime secret bundle',
  );
  assertAllowedKeys(
    assertion,
    ['private_key_pem', 'key_id'],
    'sandbox assertion runtime secret bundle',
  );
  env['AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY'] = requiredRecordString(
    assertion,
    'private_key_pem',
    'sandbox assertion private key',
  );
  env['AIHUB_SANDBOX_ASSERTION_KID'] = requiredRecordString(
    assertion,
    'key_id',
    'sandbox assertion key id',
  );
}

function resolveScope(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): RuntimeConnectionScope {
  const rawScope = env['AIHUB_RUNTIME_DATABASE_SCOPE']?.trim();
  const nodeEnv = env['NODE_ENV']?.trim();
  const isDeployed = nodeEnv === 'production' || nodeEnv === 'staging';

  if (rawScope === undefined || rawScope.length === 0) {
    if (isDeployed) {
      throw configurationError(
        'AIHUB_RUNTIME_DATABASE_SCOPE is required in deployed modes',
      );
    }
    return 'production';
  }

  const scope = rawScope;
  if (scope !== 'production' && scope !== 'sandbox') {
    throw configurationError('AIHUB_RUNTIME_DATABASE_SCOPE is invalid');
  }
  return scope;
}

function parsePoolerEnabled(value: string | undefined): boolean {
  const normalized = value?.trim() || 'false';
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw configurationError('AIHUB_DATABASE_POOLER_ENABLED is invalid');
}

function configurationError(
  message: string,
): RuntimeConnectionConfigurationError {
  return new RuntimeConnectionConfigurationError(message);
}

function asRecord(value: unknown, label: string): SecretDocument {
  return asDocument(value, label, configurationError);
}

function assertAllowedKeys(
  record: SecretDocument,
  allowedKeys: readonly string[],
  label: string,
): void {
  assertOnlyFields(record, allowedKeys, label, configurationError);
}

function requiredRecordString(
  record: SecretDocument,
  key: string,
  label: string,
): string {
  return requiredDocumentString(
    record,
    key,
    `required runtime connection is missing: ${label}`,
    configurationError,
  );
}

function optionalRecordString(
  record: SecretDocument,
  key: string,
  label: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw configurationError(
      `optional runtime connection is invalid: ${label}`,
    );
  }
  return value;
}
