import { AppError } from '@/common/errors/app-error';
import { isEndUserId } from '@/modules/identity/domain/end-user-id';
import {
  type PublicJsonWebKey,
  parsePublicJsonWebKeySet,
} from '@/modules/identity/domain/organization-identity-config';
import type { OrganizationIdentityConfig } from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import type { JwksKeyProviderPort } from './jwks-key-provider.port';
import type {
  UserAssertionCryptoPort,
  UserAssertionProtectedHeader,
} from './user-assertion-crypto.port';
import {
  identityProviderUnavailable,
  invalidSignedUserAssertion,
} from './user-identity-errors';
import type { ResolvedUserIdentity } from './user-identity-resolver.port';

export interface SignedUserAssertionInput {
  readonly signedAssertion: string;
  readonly organizationId: string;
  /** The Organization's active identity configuration, already loaded. */
  readonly config: OrganizationIdentityConfig;
}

const ASSERTION_CLOCK_SKEW_SECONDS = 60;
const MAX_ASSERTION_BYTES = 32 * 1024;
const MAX_CLAIM_STRING_LENGTH = 256;

function isAllowedAlgorithm(
  value: unknown,
  config: OrganizationIdentityConfig,
): value is OrganizationIdentityConfig['allowedAlgorithms'][number] {
  return (
    (value === 'RS256' || value === 'ES256') &&
    config.allowedAlgorithms.includes(value)
  );
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CLAIM_STRING_LENGTH
  );
}

function isIntegerSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isUsableKeyForAlgorithm(
  key: PublicJsonWebKey,
  algorithm: 'RS256' | 'ES256',
): boolean {
  const expectedKty = algorithm === 'RS256' ? 'RSA' : 'EC';
  if (key.kty !== expectedKty) {
    return false;
  }

  if (key.alg !== undefined && key.alg !== algorithm) {
    return false;
  }

  if (key.use !== undefined && key.use !== 'sig') {
    return false;
  }

  if (
    key.key_ops !== undefined &&
    (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify'))
  ) {
    return false;
  }

  return true;
}

function selectKey(
  keys: readonly PublicJsonWebKey[],
  algorithm: 'RS256' | 'ES256',
  kid: string | undefined,
): PublicJsonWebKey | undefined {
  const matches = keys.filter((key) => {
    if (parsePublicJsonWebKeySet({ keys: [key] }) === undefined) {
      return false;
    }

    if (!isUsableKeyForAlgorithm(key, algorithm)) {
      return false;
    }

    return kid === undefined || key.kid === kid;
  });

  return matches.length === 1 ? matches[0] : undefined;
}

function protectedHeader(
  crypto: UserAssertionCryptoPort,
  signedAssertion: string,
): {
  algorithm: 'RS256' | 'ES256';
  kid?: string;
} {
  if (
    signedAssertion.length === 0 ||
    Buffer.byteLength(signedAssertion, 'utf8') > MAX_ASSERTION_BYTES
  ) {
    throw invalidSignedUserAssertion();
  }

  let header: UserAssertionProtectedHeader;
  try {
    header = crypto.decodeHeader(signedAssertion);
  } catch (error) {
    throw invalidSignedUserAssertion(error);
  }

  if (header.alg !== 'RS256' && header.alg !== 'ES256') {
    throw invalidSignedUserAssertion();
  }

  if (header.kid !== undefined && typeof header.kid !== 'string') {
    throw invalidSignedUserAssertion();
  }

  if (header.kid === '') {
    throw invalidSignedUserAssertion();
  }

  return {
    algorithm: header.alg,
    ...(header.kid === undefined ? {} : { kid: header.kid }),
  };
}

function validateClaims(
  payload: Readonly<Record<string, unknown>>,
  config: OrganizationIdentityConfig,
  nowSeconds: number,
): { userId: string } {
  if (
    payload.iss !== config.issuer ||
    payload.aud !== 'aihub' ||
    !isEndUserId(payload.sub) ||
    !isBoundedString(payload.jti) ||
    !isIntegerSeconds(payload.iat) ||
    !isIntegerSeconds(payload.exp) ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > config.maxAssertionTtlSeconds ||
    payload.exp <= nowSeconds - ASSERTION_CLOCK_SKEW_SECONDS ||
    payload.iat >= nowSeconds + ASSERTION_CLOCK_SKEW_SECONDS
  ) {
    throw invalidSignedUserAssertion();
  }

  return { userId: payload.sub };
}

export class UserAssertionVerifier {
  constructor(
    private readonly keyProvider: JwksKeyProviderPort,
    private readonly crypto: UserAssertionCryptoPort,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
  ) {}

  async verify(input: SignedUserAssertionInput): Promise<ResolvedUserIdentity> {
    if (
      input.organizationId.trim().length === 0 ||
      input.signedAssertion.trim().length === 0
    ) {
      throw invalidSignedUserAssertion();
    }

    const { config } = input;
    const header = protectedHeader(this.crypto, input.signedAssertion);

    if (!isAllowedAlgorithm(header.algorithm, config)) {
      throw invalidSignedUserAssertion();
    }

    let jwks = await this.loadKeys(input.organizationId, config);
    let key = selectKey(jwks.keys, header.algorithm, header.kid);

    if (key === undefined && header.kid !== undefined) {
      jwks = await this.loadKeys(input.organizationId, config, true);
      key = selectKey(jwks.keys, header.algorithm, header.kid);
    }

    if (key === undefined) {
      throw invalidSignedUserAssertion();
    }

    let verified: Readonly<Record<string, unknown>>;
    const nowSeconds = this.now();
    try {
      verified = await this.crypto.verify({
        signedAssertion: input.signedAssertion,
        key,
        algorithm: header.algorithm,
      });
    } catch (error) {
      throw invalidSignedUserAssertion(error);
    }

    const claims = validateClaims(verified, config, nowSeconds);
    return {
      userId: claims.userId,
      organizationId: input.organizationId,
      scopes: [],
    };
  }

  private async loadKeys(
    organizationId: string,
    config: OrganizationIdentityConfig,
    forceRefresh = false,
  ) {
    try {
      return await this.keyProvider.resolve({
        organizationId,
        config,
        ...(forceRefresh ? { forceRefresh: true } : {}),
      });
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === 'IDENTITY_PROVIDER_UNAVAILABLE'
      ) {
        throw error;
      }

      throw identityProviderUnavailable(error);
    }
  }
}
