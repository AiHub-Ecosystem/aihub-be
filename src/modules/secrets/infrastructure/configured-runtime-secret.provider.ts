import { readFileSync } from 'node:fs';

import type {
  AiSpeakingRuntimeSecrets,
  AiWritingRuntimeSecrets,
  EmailOutboxRuntimeSecrets,
  ResendRuntimeSecrets,
  RuntimeSecretProvider,
  RuntimeSecretSnapshot,
  SeaweedFsRuntimeSecrets,
  UserAccessJwtRuntimeSecrets,
  WebSessionRuntimeSecrets,
} from '@/modules/secrets/application/runtime-secret-provider.port';

type RuntimeSecretSource = 'env' | 'agent-file';
type SecretValues = Readonly<Record<string, string | undefined>>;
type ReadFile = (path: string) => string;

export interface RuntimeSecretProviderOptions {
  readonly nodeEnv: string | undefined;
  readonly source: string | undefined;
  readonly secretsFile: string | undefined;
  readonly values: SecretValues;
  readonly readFile?: ReadFile;
}

export class RuntimeSecretConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeSecretConfigurationError';
  }
}

export function createRuntimeSecretProvider(
  options: RuntimeSecretProviderOptions,
): RuntimeSecretProvider {
  return new ConfiguredRuntimeSecretProvider(options);
}

export class ConfiguredRuntimeSecretProvider implements RuntimeSecretProvider {
  private readonly snapshot: RuntimeSecretSnapshot;

  constructor(options: RuntimeSecretProviderOptions) {
    const source = resolveSource(options);
    this.snapshot = Object.freeze(
      source === 'env'
        ? loadFromEnvironment(options)
        : loadFromAgentFile(options),
    );
  }

  getSnapshot(): RuntimeSecretSnapshot {
    return this.snapshot;
  }
}

function resolveSource(
  options: RuntimeSecretProviderOptions,
): RuntimeSecretSource {
  const explicitSource = options.source?.trim();
  if (explicitSource === 'env' || explicitSource === 'agent-file') {
    if (
      explicitSource === 'env' &&
      options.nodeEnv !== 'development' &&
      options.nodeEnv !== 'test'
    ) {
      throw configurationError(
        'environment source is allowed only for local development and tests',
      );
    }
    return explicitSource;
  }

  if (explicitSource !== undefined && explicitSource.length > 0) {
    throw configurationError('AIHUB_RUNTIME_SECRET_SOURCE is invalid');
  }

  if (hasValue(options.secretsFile)) {
    return 'agent-file';
  }

  throw configurationError(
    'AIHUB_RUNTIME_SECRET_SOURCE or AIHUB_RUNTIME_SECRETS_FILE is required',
  );
}

function loadFromEnvironment(
  options: RuntimeSecretProviderOptions,
): RuntimeSecretSnapshot {
  const getRequired = (name: string, label: string): string => {
    const value = options.values[name];
    if (hasValue(value)) {
      return value;
    }
    throw configurationError(`required runtime secret is missing: ${label}`);
  };

  const aiSpeaking: AiSpeakingRuntimeSecrets = {
    clientId: getRequired(
      'DOWNSTREAM_AI_SPEAKING_CLIENT_ID',
      'ai-speaking client id',
    ),
    secretKey: getRequired(
      'DOWNSTREAM_AI_SPEAKING_SECRET_KEY',
      'ai-speaking secret key',
    ),
  };
  const aiWriting: AiWritingRuntimeSecrets = {
    token: getRequired('DOWNSTREAM_AI_WRITING_TOKEN', 'ai-writing token'),
  };
  const resend: ResendRuntimeSecrets = {
    apiKey: getRequired('RESEND_API_KEY', 'Resend API key'),
  };
  const userAccessJwt: UserAccessJwtRuntimeSecrets = {
    privateKeyPem: getRequired(
      'AIHUB_USER_ACCESS_JWT_PRIVATE_KEY',
      'User Access JWT private key',
    ),
    keyId: getRequired('AIHUB_USER_ACCESS_JWT_KID', 'User Access JWT key id'),
  };

  const seaweedfs = loadOptionalSeaweedFs(options.values);
  const emailOutbox = loadEmailOutboxFromEnvironment(options.values);
  return freezeSnapshot(
    aiSpeaking,
    aiWriting,
    resend,
    userAccessJwt,
    seaweedfs,
    emailOutbox,
    loadOptionalWebSession(options.values),
  );
}

function loadFromAgentFile(
  options: RuntimeSecretProviderOptions,
): RuntimeSecretSnapshot {
  const path = options.secretsFile?.trim();
  if (path === undefined || path.length === 0) {
    throw configurationError('AIHUB_RUNTIME_SECRETS_FILE is required');
  }

  let raw: string;
  try {
    raw = (options.readFile ?? defaultReadFile)(path);
  } catch {
    throw configurationError('runtime secret file cannot be read');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configurationError('runtime secret file is not valid JSON');
  }

  const root = asRecord(parsed, 'runtime secret document');
  assertAllowedKeys(
    root,
    [
      'ai-speaking',
      'ai-writing',
      'resend',
      'user-access-jwt',
      'seaweedfs',
      'email-outbox',
      'web-session',
    ],
    'runtime secret document',
  );
  const aiSpeakingRecord = asRecord(
    root['ai-speaking'],
    'ai-speaking runtime secret bundle',
  );
  assertAllowedKeys(
    aiSpeakingRecord,
    ['client_id', 'secret_key'],
    'ai-speaking runtime secret bundle',
  );
  const aiWritingRecord = asRecord(
    root['ai-writing'],
    'ai-writing runtime secret bundle',
  );
  assertAllowedKeys(
    aiWritingRecord,
    ['token'],
    'ai-writing runtime secret bundle',
  );
  const aiSpeaking: AiSpeakingRuntimeSecrets = {
    clientId: requiredRecordString(
      aiSpeakingRecord,
      'client_id',
      'ai-speaking client id',
    ),
    secretKey: requiredRecordString(
      aiSpeakingRecord,
      'secret_key',
      'ai-speaking secret key',
    ),
  };
  const aiWriting: AiWritingRuntimeSecrets = {
    token: requiredRecordString(aiWritingRecord, 'token', 'ai-writing token'),
  };
  const resendRecord = asRecord(root.resend, 'Resend runtime secret bundle');
  assertAllowedKeys(resendRecord, ['api_key'], 'Resend runtime secret bundle');
  const resend: ResendRuntimeSecrets = {
    apiKey: requiredRecordString(resendRecord, 'api_key', 'Resend API key'),
  };

  const userAccessJwtRecord = asRecord(
    root['user-access-jwt'],
    'User Access JWT runtime secret bundle',
  );
  assertAllowedKeys(
    userAccessJwtRecord,
    ['private_key_pem', 'key_id'],
    'User Access JWT runtime secret bundle',
  );
  const userAccessJwt: UserAccessJwtRuntimeSecrets = {
    privateKeyPem: requiredRecordString(
      userAccessJwtRecord,
      'private_key_pem',
      'User Access JWT private key',
    ),
    keyId: requiredRecordString(
      userAccessJwtRecord,
      'key_id',
      'User Access JWT key id',
    ),
  };

  const seaweedfsValue = root.seaweedfs;
  const seaweedfs =
    seaweedfsValue === undefined
      ? undefined
      : loadSeaweedFsRecord(
          asRecord(seaweedfsValue, 'SeaweedFS runtime secret bundle'),
        );
  if (seaweedfs !== undefined) {
    assertAllowedKeys(
      asRecord(seaweedfsValue, 'SeaweedFS runtime secret bundle'),
      ['access_key_id', 'secret_access_key'],
      'SeaweedFS runtime secret bundle',
    );
  }
  const emailOutboxRecord = asRecord(
    root['email-outbox'],
    'email-outbox runtime secret bundle',
  );
  assertAllowedKeys(
    emailOutboxRecord,
    ['current_key_id', 'keys'],
    'email-outbox runtime secret bundle',
  );
  const emailOutbox = loadEmailOutboxRecord(emailOutboxRecord);
  // Required, not optional: a production or staging instance that renders no
  // Web Session bundle must refuse to boot rather than serve the Web Session
  // routes as open ones.
  const webSessionRecord = asRecord(
    root['web-session'],
    'Web Session runtime secret bundle',
  );
  assertAllowedKeys(
    webSessionRecord,
    ['client_secret'],
    'Web Session runtime secret bundle',
  );
  const webSession: WebSessionRuntimeSecrets = {
    clientSecret: requiredRecordString(
      webSessionRecord,
      'client_secret',
      'Customer Web BFF client secret',
    ),
  };
  return freezeSnapshot(
    aiSpeaking,
    aiWriting,
    resend,
    userAccessJwt,
    seaweedfs,
    emailOutbox,
    webSession,
  );
}

function loadEmailOutboxFromEnvironment(
  values: SecretValues,
): EmailOutboxRuntimeSecrets {
  const currentKeyId = values.EMAIL_OUTBOX_CURRENT_KEY_ID;
  const keysJson = values.EMAIL_OUTBOX_KEYS;
  if (!hasValue(currentKeyId) || !hasValue(keysJson)) {
    throw configurationError(
      'required runtime secret is missing: email-outbox key bundle',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(keysJson);
  } catch {
    throw configurationError('email-outbox keys are not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw configurationError('email-outbox keys have an invalid shape');
  }
  const keys: Record<string, string> = {};
  for (const [keyId, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw configurationError('email-outbox keys have an invalid shape');
    }
    keys[keyId] = value;
  }
  const bundle: EmailOutboxRuntimeSecrets = { currentKeyId, keys };
  if (!Object.prototype.hasOwnProperty.call(keys, currentKeyId)) {
    throw configurationError('email-outbox current key id is not provisioned');
  }
  return bundle;
}

function loadEmailOutboxRecord(
  record: Record<string, unknown>,
): EmailOutboxRuntimeSecrets {
  const currentKeyId = requiredRecordString(
    record,
    'current_key_id',
    'email-outbox current key id',
  );
  const keysValue = record.keys;
  if (!isRecord(keysValue)) {
    throw configurationError('email-outbox keys have an invalid shape');
  }
  const keys: Record<string, string> = {};
  for (const [keyId, value] of Object.entries(keysValue)) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw configurationError('email-outbox keys have an invalid shape');
    }
    keys[keyId] = value;
  }
  if (Object.keys(keys).length === 0 || !(currentKeyId in keys)) {
    throw configurationError('email-outbox current key id is not provisioned');
  }
  return { currentKeyId, keys };
}

/**
 * The one runtime secret a local environment may leave out. Every other
 * credential is required in both sources, because AIHUB cannot serve a request
 * without one; the Customer Web BFF client secret gates routes a deployment
 * that has no Customer Web may never call, so its absence is a state the
 * routes report rather than a boot failure.
 */
function loadOptionalWebSession(
  values: SecretValues,
): WebSessionRuntimeSecrets | undefined {
  const clientSecret = values.AIHUB_WEB_SESSION_CLIENT_SECRET;
  return hasValue(clientSecret) ? { clientSecret } : undefined;
}

function loadOptionalSeaweedFs(
  values: SecretValues,
): SeaweedFsRuntimeSecrets | undefined {
  const accessKeyId = values.SEAWEEDFS_ACCESS_KEY_ID;
  const secretAccessKey = values.SEAWEEDFS_SECRET_ACCESS_KEY;
  if (!hasValue(accessKeyId) && !hasValue(secretAccessKey)) {
    return undefined;
  }
  if (!hasValue(accessKeyId) || !hasValue(secretAccessKey)) {
    throw configurationError('SeaweedFS runtime secret bundle is incomplete');
  }
  return { accessKeyId, secretAccessKey };
}

function loadSeaweedFsRecord(
  record: Record<string, unknown>,
): SeaweedFsRuntimeSecrets {
  return {
    accessKeyId: requiredRecordString(
      record,
      'access_key_id',
      'SeaweedFS access key id',
    ),
    secretAccessKey: requiredRecordString(
      record,
      'secret_access_key',
      'SeaweedFS secret access key',
    ),
  };
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw configurationError(`${label} contains unexpected fields`);
  }
}

function requiredRecordString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw configurationError(`required runtime secret is missing: ${label}`);
  }
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw configurationError(`${label} has an invalid shape`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freezeSnapshot(
  aiSpeaking: AiSpeakingRuntimeSecrets,
  aiWriting: AiWritingRuntimeSecrets,
  resend: ResendRuntimeSecrets,
  userAccessJwt: UserAccessJwtRuntimeSecrets,
  seaweedfs: SeaweedFsRuntimeSecrets | undefined,
  emailOutbox: EmailOutboxRuntimeSecrets,
  webSession: WebSessionRuntimeSecrets | undefined,
): RuntimeSecretSnapshot {
  const snapshot = {
    aiSpeaking: Object.freeze(aiSpeaking),
    aiWriting: Object.freeze(aiWriting),
    resend: Object.freeze(resend),
    userAccessJwt: Object.freeze(userAccessJwt),
    ...(seaweedfs === undefined ? {} : { seaweedfs: Object.freeze(seaweedfs) }),
    emailOutbox: Object.freeze({
      currentKeyId: emailOutbox.currentKeyId,
      keys: Object.freeze({ ...emailOutbox.keys }),
    }),
    ...(webSession === undefined
      ? {}
      : { webSession: Object.freeze(webSession) }),
  };
  return Object.freeze(snapshot);
}

function hasValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function configurationError(message: string): RuntimeSecretConfigurationError {
  return new RuntimeSecretConfigurationError(message);
}
