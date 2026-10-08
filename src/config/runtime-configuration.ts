import { registerAs } from '@nestjs/config';
import { type TSchema, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

type RuntimeMode = 'development' | 'test' | 'staging' | 'production';
type RuntimeKind = 'string' | 'number' | 'boolean' | 'enum';

interface RuntimeField {
  readonly kind: RuntimeKind;
  readonly defaultValue?: string | number | boolean;
  readonly values?: readonly string[];
  readonly requiredIn?: readonly RuntimeMode[];
  /** Require env-mode values, limited to requiredIn when modes are specified. */
  readonly requiredWhenSecretSource?: boolean;
  readonly secret?: boolean;
  readonly allowEmpty?: boolean;
  readonly format?: 'url' | 'uri' | 'hostname';
  readonly minValue?: number;
  readonly maxValue?: number;
}

const MODES = ['development', 'test', 'staging', 'production'] as const;
const PROD_MODES = ['staging', 'production'] as const;

export const DEFAULT_SEAWEEDFS_ENDPOINT = 'https://s3.wispace.app';
export const DEFAULT_SEAWEEDFS_REGION = 'us-east-1';
export const DEFAULT_SEAWEEDFS_SAMPLE_BUCKET = 'aihub-speaking-samples';

export const PUBLIC_API_SERVERS = [
  {
    environment: 'production',
    hostname: 'api.aihubproduction.com',
    description: 'Production API',
  },
  {
    environment: 'sandbox',
    hostname: 'sandbox.aihubproduction.com',
    description: 'Sandbox API for testing',
  },
] as const;

const fields = {
  NODE_ENV: { kind: 'enum', values: MODES, defaultValue: 'production' },
  PORT: { kind: 'number', defaultValue: 3000, minValue: 0, maxValue: 65535 },
  LOG_LEVEL: {
    kind: 'enum',
    values: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
    defaultValue: 'info',
  },
  OTEL_SERVICE_NAME: { kind: 'string', defaultValue: 'aihub-be' },
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: {
    kind: 'string',
    allowEmpty: true,
    format: 'url',
  },
  AIHUB_ALLOW_UNAUTHENTICATED_DEV: {
    kind: 'boolean',
    defaultValue: false,
  },
  AIHUB_RUNTIME_SECRET_SOURCE: {
    kind: 'enum',
    values: ['env', 'agent-file'],
  },
  AIHUB_RUNTIME_SECRETS_FILE: { kind: 'string' },
  AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: { kind: 'string' },
  AIHUB_RUNTIME_DATABASE_SCOPE: {
    kind: 'enum',
    values: ['production', 'sandbox'],
    defaultValue: 'production',
  },
  AIHUB_USER_ACCESS_ISSUER: {
    kind: 'string',
    requiredIn: MODES,
    format: 'url',
  },
  AIHUB_PRODUCTION_HOST: {
    kind: 'string',
    requiredIn: PROD_MODES,
    format: 'hostname',
  },
  AIHUB_STAGING_HOST: { kind: 'string', format: 'hostname' },
  AIHUB_DEVELOPMENT_HOST: { kind: 'string', format: 'hostname' },
  AIHUB_SANDBOX_HOST: { kind: 'string', format: 'hostname' },
  AIHUB_SANDBOX_ORG_IDS: { kind: 'string' },
  AIHUB_SELF_SERVE_MONTHLY_REQUEST_QUOTA: {
    kind: 'number',
    defaultValue: 100,
    minValue: 1,
  },
  DATABASE_URL: {
    kind: 'string',
    secret: true,
    format: 'uri',
    requiredIn: PROD_MODES,
  },
  CONTROL_PLANE_DATABASE_URL: { kind: 'string', secret: true, format: 'uri' },
  CONTROL_PLANE_READ_DATABASE_URL: {
    kind: 'string',
    secret: true,
    format: 'uri',
  },
  REDIS_URL: {
    kind: 'string',
    secret: true,
    format: 'uri',
    requiredIn: PROD_MODES,
  },
  DOWNSTREAM_AI_WRITING_URL: {
    kind: 'string',
    requiredIn: PROD_MODES,
    format: 'url',
  },
  DOWNSTREAM_AI_SPEAKING_URL: {
    kind: 'string',
    requiredIn: PROD_MODES,
    format: 'url',
  },
  DOWNSTREAM_AI_WRITING_TOKEN: {
    kind: 'string',
    secret: true,
    requiredWhenSecretSource: true,
  },
  DOWNSTREAM_AI_SPEAKING_CLIENT_ID: {
    kind: 'string',
    secret: true,
    requiredWhenSecretSource: true,
  },
  DOWNSTREAM_AI_SPEAKING_SECRET_KEY: {
    kind: 'string',
    secret: true,
    requiredWhenSecretSource: true,
  },
  RESEND_API_KEY: {
    kind: 'string',
    secret: true,
    requiredWhenSecretSource: true,
  },
  RESEND_FROM: { kind: 'string', requiredIn: PROD_MODES },
  CUSTOMER_WEB_BASE_URL: {
    kind: 'string',
    format: 'url',
  },
  AIHUB_USER_ACCESS_JWT_PRIVATE_KEY: {
    kind: 'string',
    secret: true,
    requiredWhenSecretSource: true,
  },
  AIHUB_USER_ACCESS_JWT_KID: {
    kind: 'string',
    secret: true,
    requiredWhenSecretSource: true,
  },
  // Local env-mode value only; agent-file mode validates the Vault bundle.
  AIHUB_WEB_SESSION_CLIENT_SECRET: {
    kind: 'string',
    secret: true,
    requiredWhenSecretSource: true,
    requiredIn: PROD_MODES,
  },
  EMAIL_OUTBOX_CURRENT_KEY_ID: {
    kind: 'string',
    secret: true,
    requiredWhenSecretSource: true,
  },
  EMAIL_OUTBOX_KEYS: {
    kind: 'string',
    secret: true,
    requiredWhenSecretSource: true,
  },
  SEAWEEDFS_ENDPOINT_URL: {
    kind: 'string',
    defaultValue: DEFAULT_SEAWEEDFS_ENDPOINT,
    format: 'url',
  },
  SEAWEEDFS_BUCKET: {
    kind: 'string',
    defaultValue: DEFAULT_SEAWEEDFS_SAMPLE_BUCKET,
  },
  SEAWEEDFS_REGION: { kind: 'string', defaultValue: DEFAULT_SEAWEEDFS_REGION },
  SEAWEEDFS_USER_ASSET_BUCKET: { kind: 'string' },
  SEAWEEDFS_AUDIO_ASSET_BUCKET: { kind: 'string' },
  SEAWEEDFS_ACCESS_KEY_ID: { kind: 'string', secret: true },
  SEAWEEDFS_SECRET_ACCESS_KEY: { kind: 'string', secret: true },
  AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY: { kind: 'string', secret: true },
  AIHUB_SANDBOX_ASSERTION_KID: { kind: 'string', secret: true },
} as const satisfies Record<string, RuntimeField>;

type FieldMap = typeof fields;
type FieldValue<F> = F extends { readonly kind: 'number' }
  ? number
  : F extends { readonly kind: 'boolean' }
    ? boolean
    : F extends {
          readonly kind: 'enum';
          readonly values: readonly (infer Value extends string)[];
        }
      ? Value
      : string;

export type RuntimeConfiguration = Readonly<{
  [K in keyof FieldMap]: FieldMap[K] extends { readonly defaultValue: unknown }
    ? FieldValue<FieldMap[K]>
    : FieldValue<FieldMap[K]> | undefined;
}>;

type SecretFieldNames = {
  [K in keyof FieldMap]: FieldMap[K] extends { readonly secret: true }
    ? K
    : never;
}[keyof FieldMap];

export type PublicRuntimeConfiguration = Omit<
  RuntimeConfiguration,
  SecretFieldNames
>;

export interface RuntimeConnectionConfiguration {
  readonly databaseUrl: string | undefined;
  readonly controlPlaneDatabaseUrl: string | undefined;
  readonly controlPlaneReadDatabaseUrl: string | undefined;
  readonly redisUrl: string | undefined;
  readonly sandboxAssertionPrivateKey: string | undefined;
  readonly sandboxAssertionKeyId: string | undefined;
}

const propertySchema = (field: RuntimeField): TSchema => {
  const defaults =
    field.defaultValue === undefined ? {} : { default: field.defaultValue };
  if (field.kind === 'number') {
    return Type.Optional(Type.Number(defaults));
  }
  if (field.kind === 'boolean') {
    return Type.Optional(Type.Boolean(defaults));
  }
  if (field.kind === 'enum') {
    return Type.Optional(
      Type.Union(
        (field.values ?? []).map((value) => Type.Literal(value)),
        defaults,
      ),
    );
  }
  return Type.Optional(Type.String(defaults));
};

/** TypeBox contract for every environment variable read by Nest. */
export const runtimeEnvironmentSchema = Type.Object(
  Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [
      name,
      propertySchema(field),
    ]),
  ),
  { additionalProperties: false },
);

export const runtimeEnvironmentMetadata = Object.freeze(
  Object.fromEntries(
    (Object.entries(fields) as [string, RuntimeField][]).map(
      ([name, field]) => [
        name,
        Object.freeze({
          type: field.kind,
          defaultValue: field.defaultValue ?? null,
          requiredIn: field.requiredIn ?? [],
          secret: field.secret ?? false,
          requiredWhenSecretSource: field.requiredWhenSecretSource ?? false,
          allowedValues: field.values ?? null,
        }),
      ],
    ),
  ),
);

export class RuntimeConfigurationError extends Error {
  readonly variableNames: readonly string[];

  constructor(variableNames: readonly string[]) {
    const names = [...new Set(variableNames)].sort();
    super(`Runtime configuration is invalid: ${names.join(', ')}`);
    this.name = 'RuntimeConfigurationError';
    this.variableNames = Object.freeze(names);
  }
}

export function loadRuntimeConfiguration(
  raw: Readonly<Record<string, string | undefined>>,
): RuntimeConfiguration {
  const values: Record<string, string | number | boolean | undefined> = {};
  const problems: string[] = [];
  const modeValue = nonEmpty(raw.NODE_ENV) ?? 'production';
  const secretSource = nonEmpty(raw.AIHUB_RUNTIME_SECRET_SOURCE);
  const connectionFile = nonEmpty(raw.AIHUB_RUNTIME_SECRETS_FILE);
  const databaseScope =
    nonEmpty(raw.AIHUB_RUNTIME_DATABASE_SCOPE) ?? 'production';

  for (const [name, field] of Object.entries(fields) as [
    keyof FieldMap,
    RuntimeField,
  ][]) {
    const rawValue = field.allowEmpty ? raw[name] : nonEmpty(raw[name]);
    let value: string | number | boolean | undefined = rawValue;

    if (rawValue === undefined || rawValue === '') {
      value = field.defaultValue;
    } else if (field.kind === 'number') {
      value = Number(rawValue);
      if (
        !Number.isSafeInteger(value) ||
        value < (field.minValue ?? 1) ||
        (field.maxValue !== undefined && value > field.maxValue)
      ) {
        problems.push(name);
        value = undefined;
      }
    } else if (field.kind === 'boolean') {
      if (rawValue === 'true') value = true;
      else if (rawValue === 'false') value = false;
      else {
        problems.push(name);
        value = undefined;
      }
    }

    if (
      value === undefined &&
      (field.requiredWhenSecretSource
        ? secretSource === 'env' &&
          (field.requiredIn === undefined ||
            field.requiredIn.includes(modeValue as RuntimeMode))
        : field.requiredIn?.includes(modeValue as RuntimeMode))
    ) {
      problems.push(name);
    }

    if (typeof value === 'string' && value.length > 0) {
      if (
        field.kind === 'enum' &&
        !((field.values ?? []) as readonly string[]).includes(value)
      ) {
        problems.push(name);
      }
      if (field.format === 'url' && !validUrl(value, false)) {
        problems.push(name);
      }
      if (field.format === 'uri' && !validUrl(value, true)) {
        problems.push(name);
      }
      if (field.format === 'hostname' && !validHostname(value)) {
        problems.push(name);
      }
    }
    values[name] = value;
  }

  if (!MODES.includes(modeValue as RuntimeMode)) problems.push('NODE_ENV');
  if (
    (values.SEAWEEDFS_ENDPOINT_URL as string | undefined) !== undefined &&
    values.SEAWEEDFS_ENDPOINT_URL !== DEFAULT_SEAWEEDFS_ENDPOINT
  ) {
    problems.push('SEAWEEDFS_ENDPOINT_URL');
  }
  if (
    isProductionLike(modeValue as RuntimeMode) &&
    databaseScope !== 'sandbox' &&
    nonEmpty(raw.CUSTOMER_WEB_BASE_URL) === undefined
  ) {
    problems.push('CUSTOMER_WEB_BASE_URL');
  }
  if (
    secretSource !== undefined &&
    secretSource !== 'env' &&
    secretSource !== 'agent-file'
  ) {
    problems.push('AIHUB_RUNTIME_SECRET_SOURCE');
  }
  if (secretSource === undefined && connectionFile === undefined) {
    problems.push('AIHUB_RUNTIME_SECRET_SOURCE', 'AIHUB_RUNTIME_SECRETS_FILE');
  }
  if (
    secretSource === 'agent-file' &&
    nonEmpty(raw.AIHUB_RUNTIME_SECRETS_FILE) === undefined
  ) {
    problems.push('AIHUB_RUNTIME_SECRETS_FILE');
  }
  if (
    secretSource === 'env' &&
    modeValue !== 'development' &&
    modeValue !== 'test'
  ) {
    problems.push('AIHUB_RUNTIME_SECRET_SOURCE');
  }
  if (
    raw.SEAWEEDFS_ACCESS_KEY_ID !== undefined &&
    nonEmpty(raw.SEAWEEDFS_ACCESS_KEY_ID) !== undefined &&
    nonEmpty(raw.SEAWEEDFS_SECRET_ACCESS_KEY) === undefined
  ) {
    problems.push('SEAWEEDFS_SECRET_ACCESS_KEY');
  }
  if (
    raw.SEAWEEDFS_SECRET_ACCESS_KEY !== undefined &&
    nonEmpty(raw.SEAWEEDFS_SECRET_ACCESS_KEY) !== undefined &&
    nonEmpty(raw.SEAWEEDFS_ACCESS_KEY_ID) === undefined
  ) {
    problems.push('SEAWEEDFS_ACCESS_KEY_ID');
  }

  const validationErrors = [...Value.Errors(runtimeEnvironmentSchema, values)];
  for (const error of validationErrors) {
    const name = error.path.split('/')[1];
    if (name !== undefined) problems.push(name);
  }

  const configuration = values as RuntimeConfiguration;
  validateCustomerWebUrl(configuration, problems);
  validateHostBindings(configuration, problems);
  if (problems.length > 0) throw new RuntimeConfigurationError(problems);
  return Object.freeze(configuration);
}

let singleton: RuntimeConfiguration | undefined;

export function initializeRuntimeConfiguration(
  raw: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeConfiguration {
  singleton ??= loadRuntimeConfiguration(raw);
  return singleton;
}

export function getRuntimeConfiguration(): RuntimeConfiguration {
  return initializeRuntimeConfiguration();
}

export function getRuntimeSecretEnvironment(): Readonly<
  Record<string, string | undefined>
> {
  const config = getRuntimeConfiguration();
  return Object.freeze(
    Object.fromEntries(
      (Object.entries(fields) as [string, RuntimeField][])
        .filter(([, field]) => field.secret)
        .map(([name]) => [name, config[name as keyof RuntimeConfiguration]]),
    ) as Record<string, string | undefined>,
  );
}

export function getRuntimeConnectionConfiguration(): RuntimeConnectionConfiguration {
  const configuration = getRuntimeConfiguration();
  return Object.freeze({
    databaseUrl: configuration.DATABASE_URL,
    controlPlaneDatabaseUrl:
      configuration.CONTROL_PLANE_DATABASE_URL ?? configuration.DATABASE_URL,
    controlPlaneReadDatabaseUrl:
      configuration.CONTROL_PLANE_READ_DATABASE_URL ??
      configuration.CONTROL_PLANE_DATABASE_URL ??
      configuration.DATABASE_URL,
    redisUrl: configuration.REDIS_URL,
    sandboxAssertionPrivateKey:
      configuration.AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY,
    sandboxAssertionKeyId: configuration.AIHUB_SANDBOX_ASSERTION_KID,
  });
}

export const appConfig = registerAs('app', (): PublicRuntimeConfiguration => {
  const configuration = getRuntimeConfiguration();
  const publicConfiguration = Object.fromEntries(
    (Object.entries(fields) as [string, RuntimeField][])
      .filter(([, field]) => !field.secret)
      .map(([name]) => [
        name,
        configuration[name as keyof RuntimeConfiguration],
      ]),
  );
  return Object.freeze(publicConfiguration) as PublicRuntimeConfiguration;
});

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function validUrl(value: string, allowCredentials: boolean): boolean {
  try {
    const url = new URL(value);
    return (
      url.hostname.length > 0 &&
      (allowCredentials ||
        url.protocol === 'http:' ||
        url.protocol === 'https:') &&
      (allowCredentials || (!url.username && !url.password))
    );
  } catch {
    return false;
  }
}

function validHostname(value: string): boolean {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(
    value.trim().replace(/\.$/, ''),
  );
}

function validateCustomerWebUrl(
  config: RuntimeConfiguration,
  problems: string[],
): void {
  const value = config.CUSTOMER_WEB_BASE_URL;
  if (value === undefined) {
    if (
      isProductionLike(config.NODE_ENV) &&
      config.AIHUB_RUNTIME_DATABASE_SCOPE !== 'sandbox'
    ) {
      problems.push('CUSTOMER_WEB_BASE_URL');
    }
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    problems.push('CUSTOMER_WEB_BASE_URL');
    return;
  }
  if (
    url.search ||
    url.hash ||
    (isProductionLike(config.NODE_ENV) && url.protocol !== 'https:')
  ) {
    problems.push('CUSTOMER_WEB_BASE_URL');
  }
}

function validateHostBindings(
  config: RuntimeConfiguration,
  problems: string[],
): void {
  const names = [
    'AIHUB_PRODUCTION_HOST',
    'AIHUB_STAGING_HOST',
    'AIHUB_DEVELOPMENT_HOST',
    'AIHUB_SANDBOX_HOST',
  ] as const;
  const seen = new Set<string>();
  for (const name of names) {
    const value = config[name];
    if (value === undefined) continue;
    const normalized = value.trim().toLowerCase().replace(/\.$/, '');
    if (seen.has(normalized)) problems.push(name);
    seen.add(normalized);
    if (
      config.NODE_ENV !== 'development' &&
      config.NODE_ENV !== 'test' &&
      normalized ===
        (
          {
            AIHUB_PRODUCTION_HOST: 'api.aihub.example.com',
            AIHUB_STAGING_HOST: 'staging-api.aihub.example.com',
            AIHUB_DEVELOPMENT_HOST: 'dev-api.aihub.example.com',
            AIHUB_SANDBOX_HOST: 'sandbox.aihub.example.com',
          } as const
        )[name]
    ) {
      problems.push(name);
    }
  }
  if (
    config.AIHUB_ALLOW_UNAUTHENTICATED_DEV &&
    config.NODE_ENV !== 'development' &&
    config.NODE_ENV !== 'test'
  ) {
    problems.push('AIHUB_ALLOW_UNAUTHENTICATED_DEV');
  }
}

function isProductionLike(mode: RuntimeMode): boolean {
  return mode === 'production' || mode === 'staging';
}
