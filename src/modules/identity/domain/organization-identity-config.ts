export const IDENTITY_CONFIG_ALGORITHMS = ['RS256', 'ES256'] as const;

export type IdentityConfigAlgorithm =
  (typeof IDENTITY_CONFIG_ALGORITHMS)[number];

export const DEFAULT_ASSERTION_TTL_SECONDS = 300;
export const MAX_ASSERTION_TTL_SECONDS = 3_600;

export type IdentityConfigStatus = 'active' | 'disabled';

export interface PublicJsonWebKey {
  readonly [member: string]: unknown;
}

export interface PublicJsonWebKeySet {
  readonly keys: readonly PublicJsonWebKey[];
}

const PRIVATE_JWK_MEMBERS = new Set([
  'd',
  'p',
  'q',
  'dp',
  'dq',
  'qi',
  'oth',
  'k',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function base64UrlString(value: unknown): value is string {
  return nonEmptyString(value) && /^[A-Za-z0-9_-]+$/.test(value);
}

function hasPublicKeyMaterial(key: Record<string, unknown>): boolean {
  if (key.kty === 'RSA') {
    return base64UrlString(key.n) && base64UrlString(key.e);
  }

  if (key.kty === 'EC') {
    return (
      key.crv === 'P-256' && base64UrlString(key.x) && base64UrlString(key.y)
    );
  }

  return false;
}

function hasUsableKeyMetadata(key: Record<string, unknown>): boolean {
  if (
    key.kid !== undefined &&
    (typeof key.kid !== 'string' || key.kid.length === 0)
  ) {
    return false;
  }

  if (key.use !== undefined && key.use !== 'sig') {
    return false;
  }

  if (key.key_ops !== undefined) {
    return (
      Array.isArray(key.key_ops) &&
      key.key_ops.every((operation) => typeof operation === 'string') &&
      key.key_ops.includes('verify')
    );
  }

  return true;
}

export function parsePublicJsonWebKeySet(
  value: unknown,
): PublicJsonWebKeySet | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.keys) ||
    value.keys.length === 0
  ) {
    return undefined;
  }

  const keys: PublicJsonWebKey[] = [];
  for (const candidate of value.keys) {
    if (
      !isRecord(candidate) ||
      !hasPublicKeyMaterial(candidate) ||
      !hasUsableKeyMetadata(candidate)
    ) {
      return undefined;
    }

    if (
      Object.keys(candidate).some((member) => PRIVATE_JWK_MEMBERS.has(member))
    ) {
      return undefined;
    }

    if (
      candidate.alg !== undefined &&
      candidate.alg !== 'RS256' &&
      candidate.alg !== 'ES256'
    ) {
      return undefined;
    }

    if (
      (candidate.alg === 'RS256' && candidate.kty !== 'RSA') ||
      (candidate.alg === 'ES256' && candidate.kty !== 'EC')
    ) {
      return undefined;
    }

    keys.push({ ...candidate });
  }

  return { keys };
}
