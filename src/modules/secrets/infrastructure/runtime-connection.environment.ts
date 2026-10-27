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

  const database = asRecord(root.database, 'database runtime secret bundle');
  const redis = asRecord(root.redis, 'Redis runtime secret bundle');
  assertAllowedKeys(
    database,
    [
      'url',
      'sandbox_url',
      'sandbox_control_plane_read_url',
      'email_send_budget_url',
    ],
    'database runtime secret bundle',
  );
  assertAllowedKeys(
    redis,
    ['url', 'sandbox_url', 'email_send_rate_url'],
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
  env.AIHUB_EMAIL_DAILY_BUDGET_DATABASE_URL = requiredRecordString(
    database,
    'email_send_budget_url',
    'shared email daily budget database URL',
  );
  env.REDIS_URL = requiredRecordString(
    redis,
    scope === 'sandbox' ? 'sandbox_url' : 'url',
    scope === 'sandbox' ? 'sandbox Redis URL' : 'Redis URL',
  );
  env.AIHUB_EMAIL_SEND_RATE_REDIS_URL = requiredRecordString(
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

function resolveScope(value: string | undefined): RuntimeConnectionScope {
  const scope = value?.trim() || 'production';
  if (scope !== 'production' && scope !== 'sandbox') {
    throw configurationError('AIHUB_RUNTIME_DATABASE_SCOPE is invalid');
  }
  return scope;
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
