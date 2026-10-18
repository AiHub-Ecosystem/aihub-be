/** The shared prefix every key issued before ADR-0095 carries. */
export const API_KEY_PREFIX = 'aihub_sk_';

/** The environments a newly issued key may be bound to. */
export type KeyEnvironment = 'sandbox' | 'production' | 'staging';

/**
 * The prefix a newly issued key advertises for the environment it is bound to.
 * It is a recognition hint and nothing more: authorization reads the durable
 * `allowed_environments`, so a prefix never grants access. Environments ADR-0095
 * did not name keep the shared prefix rather than invent one.
 */
const ENVIRONMENT_PREFIXES: Readonly<Record<KeyEnvironment, string>> = {
  sandbox: 'aihub_sandbox_',
  production: 'aihub_prod_',
  staging: API_KEY_PREFIX,
};

const KNOWN_PREFIXES: readonly string[] = [
  ...new Set(Object.values(ENVIRONMENT_PREFIXES)),
];

/** base62 over 32 bytes of CSPRNG output, left-padded to a fixed width. */
const API_KEY_SECRET_LENGTH = 43;
/** Six characters beyond the prefix: enough to recognise a key, useless to replay. */
const DISPLAY_PREFIX_LENGTH = 6;

export interface GeneratedApiKey {
  readonly id: string;
  readonly raw: string;
  readonly hash: string;
  readonly prefix: string;
}

/**
 * Every credential shape a key may take, as anchored regular expressions.
 *
 * Published formats live in contracts, which may not import from a module;
 * `api-key.spec.ts` checks those published patterns against a key generated for
 * each environment, so a fourth prefix cannot silently invalidate a response.
 */
const API_KEY_FORMATS: readonly string[] = KNOWN_PREFIXES.map(
  (prefix) => `^${prefix}[A-Za-z0-9]{${API_KEY_SECRET_LENGTH}}$`,
);

/** Whether a request value names an environment supported by API-key issuance. */
export function isKeyEnvironment(
  value: string | undefined,
): value is KeyEnvironment {
  return value !== undefined && Object.hasOwn(ENVIRONMENT_PREFIXES, value);
}

/** The grading scopes a Sandbox key may carry and the public demo may select. */
const GRADING_SCOPES: readonly string[] = ['writing.grade', 'speaking.grade'];

export function isGradingScope(scope: string): boolean {
  return GRADING_SCOPES.includes(scope);
}

/**
 * The display prefix for a key bound to `environment`. An environment without
 * an issued prefix, such as a local `development` key, keeps the shared one.
 */
export function apiKeyPrefixForEnvironment(environment?: string): string {
  return isKeyEnvironment(environment)
    ? ENVIRONMENT_PREFIXES[environment]
    : API_KEY_PREFIX;
}

/**
 * The environments a replacement credential keeps. Rotation narrows a legacy
 * key to its first stored environment; a key already bound to one keeps it.
 */
export function rotatedKeyEnvironments(
  stored: readonly string[],
): readonly string[] {
  return stored.slice(0, 1);
}

export function isApiKeyFormat(value: string): boolean {
  return API_KEY_FORMATS.some((format) => new RegExp(format).test(value));
}

export function apiKeyDisplayPrefix(rawKey: string): string {
  const prefix =
    KNOWN_PREFIXES.find((candidate) => rawKey.startsWith(candidate)) ??
    API_KEY_PREFIX;
  return rawKey.slice(0, prefix.length + DISPLAY_PREFIX_LENGTH);
}

/** The lifecycle AIHUB publishes for a key, wider than the durable column. */
export type ApiKeyStatus = 'active' | 'expired' | 'revoked';

/**
 * Derives the published status of a key from its durable row.
 *
 * Expiry is not stored: a key past its expiry still reads `active` in the
 * column, and authentication rejects it through a separate check. This is the
 * one place that turns the two into the single lifecycle callers see, so the
 * application and the database cannot disagree about when a key expired.
 */
export function apiKeyStatus(
  key: {
    readonly status: 'active' | 'revoked';
    readonly expiresAt: Date | null;
  },
  now: Date,
): ApiKeyStatus {
  if (key.status === 'revoked') {
    return 'revoked';
  }
  return key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime()
    ? 'expired'
    : 'active';
}
