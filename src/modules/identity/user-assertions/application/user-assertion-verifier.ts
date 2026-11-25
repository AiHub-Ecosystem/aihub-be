import { AppError } from '@/common/errors/app-error';
import { isEndUserId } from '@/common/security/end-user-id';
import {
  type PublicJsonWebKey,
  type PublicJsonWebKeySet,
  parsePublicJsonWebKeySet,
} from '@/modules/identity/domain/organization-identity-config';
import type { OrganizationIdentityConfig } from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import type { JwksKeyProviderPort } from './jwks-key-provider.port';
import { SANDBOX_ASSERTION_AUDIENCE } from './sandbox-assertion-signer.port';
import type {
  UserAssertionCryptoPort,
  UserAssertionProtectedHeader,
} from './user-assertion-crypto.port';
import type { UserAssertionReplayMarkerPort } from './user-assertion-replay-marker.port';
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
const KID_ROTATION_RELOAD_COOLDOWN_SECONDS = 5 * 60;
const MAX_TRACKED_ROTATION_RELOADS = 256;

type RotationReloadReservation = 'tracked' | 'overflow';

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

function matchesAlgorithm(
  key: PublicJsonWebKey,
  algorithm: 'RS256' | 'ES256',
): boolean {
  const expectedKty = algorithm === 'RS256' ? 'RSA' : 'EC';
  if (key['kty'] !== expectedKty) {
    return false;
  }

  if (key['alg'] !== undefined && key['alg'] !== algorithm) {
    return false;
  }

  // `use` and `key_ops` are the domain's rule; selectKey asks it first.
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

    if (!matchesAlgorithm(key, algorithm)) {
      return false;
    }

    return kid === undefined || key['kid'] === kid;
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
  audience: string,
): { userId: string; jti: string; expirationSeconds: number } {
  if (
    payload['iss'] !== config.issuer ||
    payload['aud'] !== audience ||
    !isEndUserId(payload['sub']) ||
    !isBoundedString(payload['jti']) ||
    !isIntegerSeconds(payload['iat']) ||
    !isIntegerSeconds(payload['exp']) ||
    payload['exp'] <= payload['iat'] ||
    payload['exp'] - payload['iat'] > config.maxAssertionTtlSeconds ||
    payload['exp'] <= nowSeconds - ASSERTION_CLOCK_SKEW_SECONDS ||
    payload['iat'] >= nowSeconds + ASSERTION_CLOCK_SKEW_SECONDS
  ) {
    throw invalidSignedUserAssertion();
  }

  return {
    userId: payload['sub'],
    jti: payload['jti'],
    expirationSeconds: payload['exp'],
  };
}

export class UserAssertionVerifier {
  private readonly rotationReloadCooldowns = new Map<string, number>();
  private overflowRotationReloadRetryAt: number | undefined;

  constructor(
    private readonly keyProvider: JwksKeyProviderPort,
    private readonly crypto: UserAssertionCryptoPort,
    private readonly replayMarkers: UserAssertionReplayMarkerPort,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
    private readonly runtimeScope: 'production' | 'sandbox' = 'production',
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

    let forcedRefresh = false;
    if (key === undefined && header.kid !== undefined) {
      jwks = await this.loadKeys(input.organizationId, config, {
        forceRefresh: true,
      });
      key = selectKey(jwks.keys, header.algorithm, header.kid);
      forcedRefresh = true;
    }

    if (key === undefined) {
      throw invalidSignedUserAssertion();
    }

    // A provider may rotate the key material under an unchanged `kid`; the
    // matched-but-stale key fails verification for the whole cache TTL. One
    // forced reload per Organization per cooldown covers that.
    let verified: Readonly<Record<string, unknown>>;
    try {
      verified = await this.crypto.verify({
        signedAssertion: input.signedAssertion,
        key,
        algorithm: header.algorithm,
      });
    } catch (error) {
      if (header.kid === undefined || forcedRefresh) {
        throw invalidSignedUserAssertion(error);
      }
      // Re-read the cache even while the cooldown blocks a forced reload: a
      // concurrent request may already have refreshed it.
      const reservation = this.reserveRotationReload(
        input.organizationId,
        this.now(),
      );
      const canReload = reservation !== undefined;
      let refreshed: PublicJsonWebKeySet;
      try {
        refreshed = await this.loadKeys(input.organizationId, config, {
          forceRefresh: canReload,
          rejectOnRefreshFailure: canReload,
        });
      } catch (reloadError) {
        // Keep the outage retryable: a failed reload must not hold the
        // cooldown that would block the next attempt.
        if (reservation !== undefined) {
          this.releaseRotationReload(input.organizationId, reservation);
        }
        throw reloadError;
      }
      const rotated = selectKey(refreshed.keys, header.algorithm, header.kid);
      if (rotated === undefined) {
        throw invalidSignedUserAssertion(error);
      }
      try {
        verified = await this.crypto.verify({
          signedAssertion: input.signedAssertion,
          key: rotated,
          algorithm: header.algorithm,
        });
      } catch (retryError) {
        throw invalidSignedUserAssertion(retryError);
      }
    }

    const nowSeconds = this.now();
    const claims = validateClaims(
      verified,
      config,
      this.now(),
      this.runtimeScope === 'sandbox' ? SANDBOX_ASSERTION_AUDIENCE : 'aihub',
    );
    let reserved: boolean;
    try {
      reserved = await this.replayMarkers.reserve({
        organizationId: input.organizationId,
        environment: this.runtimeScope,
        jti: claims.jti,
        ttlSeconds:
          claims.expirationSeconds + ASSERTION_CLOCK_SKEW_SECONDS - nowSeconds,
      });
    } catch (error) {
      throw identityProviderUnavailable(error);
    }
    if (!reserved) {
      throw invalidSignedUserAssertion();
    }

    return {
      userId: claims.userId,
      organizationId: input.organizationId,
      scopes: [],
      mode: 'signed_assertion',
    };
  }

  private async loadKeys(
    organizationId: string,
    config: OrganizationIdentityConfig,
    options: {
      readonly forceRefresh?: boolean;
      readonly rejectOnRefreshFailure?: boolean;
    } = {},
  ): Promise<PublicJsonWebKeySet> {
    try {
      return await this.keyProvider.resolve({
        organizationId,
        config,
        ...(options.forceRefresh === true ? { forceRefresh: true } : {}),
        ...(options.rejectOnRefreshFailure === true
          ? { rejectOnRefreshFailure: true }
          : {}),
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

  /**
   * A forged assertion can carry a real `kid`, so an unbounded reload would let
   * any unauthenticated caller drive one IdP fetch per request. One reload per
   * Organization per cooldown is enough for a real rotation.
   *
   * shortcut: the cooldown is process-local, so each instance reloads once;
   * upgrade to a shared bound if failed-assertion fetch volume is material.
   */
  private reserveRotationReload(
    organizationId: string,
    nowSeconds: number,
  ): RotationReloadReservation | undefined {
    const retryAt = this.rotationReloadCooldowns.get(organizationId);
    if (retryAt !== undefined && retryAt > nowSeconds) {
      return undefined;
    }
    this.rotationReloadCooldowns.delete(organizationId);
    if (this.rotationReloadCooldowns.size >= MAX_TRACKED_ROTATION_RELOADS) {
      for (const [tracked, retryAtSeconds] of this.rotationReloadCooldowns) {
        if (retryAtSeconds <= nowSeconds) {
          this.rotationReloadCooldowns.delete(tracked);
        }
      }
    }
    if (this.rotationReloadCooldowns.size < MAX_TRACKED_ROTATION_RELOADS) {
      this.rotationReloadCooldowns.set(
        organizationId,
        nowSeconds + KID_ROTATION_RELOAD_COOLDOWN_SECONDS,
      );
      return 'tracked';
    }
    // Every tracked cooldown is still live. Admit one untracked Organization
    // per cooldown window so other tenants' failures cannot starve a real
    // rotation, and never drop a cooldown another Organization still holds.
    if (
      this.overflowRotationReloadRetryAt !== undefined &&
      this.overflowRotationReloadRetryAt > nowSeconds
    ) {
      return undefined;
    }
    this.overflowRotationReloadRetryAt =
      nowSeconds + KID_ROTATION_RELOAD_COOLDOWN_SECONDS;
    return 'overflow';
  }

  private releaseRotationReload(
    organizationId: string,
    reservation: RotationReloadReservation,
  ): void {
    if (reservation === 'tracked') {
      this.rotationReloadCooldowns.delete(organizationId);
      return;
    }
    this.overflowRotationReloadRetryAt = undefined;
  }
}
