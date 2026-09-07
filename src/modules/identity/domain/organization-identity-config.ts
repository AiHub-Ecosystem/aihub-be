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

function hasPublicKeyMaterial(key: Record<string, unknown>): boolean {
  if (key.kty === 'RSA') {
    return nonEmptyString(key.n) && nonEmptyString(key.e);
  }

  if (key.kty === 'EC') {
    return (
      key.crv === 'P-256' && nonEmptyString(key.x) && nonEmptyString(key.y)
    );
  }

  return false;
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
    if (!isRecord(candidate) || !hasPublicKeyMaterial(candidate)) {
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
