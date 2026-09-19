import { readFileSync } from 'node:fs';
import process from 'node:process';

import type {
  AiSpeakingRuntimeSecrets,
  AiWritingRuntimeSecrets,
  ResendRuntimeSecrets,
  RuntimeSecretProvider,
  RuntimeSecretSnapshot,
  SeaweedFsRuntimeSecrets,
} from '../application/runtime-secret-provider.port';

type RuntimeSecretSource = 'env' | 'agent-file';
type SecretValues = Readonly<Record<string, string | undefined>>;
type ReadFile = (path: string) => string;

export interface RuntimeSecretProviderOptions {
  readonly nodeEnv: string | undefined;
  readonly source: string | undefined;
  readonly secretsFile: string | undefined;
  readonly allowProductionEnvSecrets?: boolean;
  readonly values: SecretValues;
  readonly readFile?: ReadFile;
}

export class RuntimeSecretConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeSecretConfigurationError';
  }
}

export function createRuntimeSecretProviderFromProcessEnvironment(): RuntimeSecretProvider {
  return new ConfiguredRuntimeSecretProvider({
    nodeEnv: process.env.NODE_ENV,
    source: process.env.AIHUB_RUNTIME_SECRET_SOURCE,
    secretsFile: process.env.AIHUB_RUNTIME_SECRETS_FILE,
    allowProductionEnvSecrets:
      process.env.AIHUB_ALLOW_PRODUCTION_ENV_SECRETS === 'true',
    values: process.env,
  });
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
      options.nodeEnv !== 'test' &&
      !(
        options.nodeEnv === 'production' &&
        options.allowProductionEnvSecrets === true
      )
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

  const seaweedfs = loadOptionalSeaweedFs(options.values);
  return freezeSnapshot(aiSpeaking, aiWriting, resend, seaweedfs);
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
    ['ai-speaking', 'ai-writing', 'resend', 'seaweedfs'],
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
  return freezeSnapshot(aiSpeaking, aiWriting, resend, seaweedfs);
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
  seaweedfs: SeaweedFsRuntimeSecrets | undefined,
): RuntimeSecretSnapshot {
  const snapshot = {
    aiSpeaking: Object.freeze(aiSpeaking),
    aiWriting: Object.freeze(aiWriting),
    resend: Object.freeze(resend),
    ...(seaweedfs === undefined ? {} : { seaweedfs: Object.freeze(seaweedfs) }),
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
