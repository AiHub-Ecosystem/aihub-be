import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { invalidUserAccessToken } from '@/modules/auth/local-credentials/application/local-auth-errors';

import {
  type CryptoKey,
  type KeyObject,
  SignJWT,
  decodeProtectedHeader,
  jwtVerify,
} from 'jose';

import { AppError } from '@/common/errors/app-error';
import {
  USER_ACCESS_TOKEN_MINIMUM_RSA_MODULUS_BITS,
  userAccessTokenRsaModulusIsAcceptable,
} from '@/modules/auth/web-sessions/application/user-access-token-key-policy';
import type {
  IssuedUserAccessToken,
  UserAccessTokenIssuerPort,
  UserAccessTokenVerifierPort,
  VerifiedUserAccessToken,
} from '@/modules/auth/web-sessions/application/user-access-token.port';

export interface UserAccessTokenConfig {
  readonly privateKeyPem: string;
  readonly keyId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly expiresInSeconds: number;
  readonly clockSkewSeconds: number;
}

export const USER_ACCESS_TOKEN_CRYPTO = Symbol('USER_ACCESS_TOKEN_CRYPTO');

const INVALID_KEY_CONFIGURATION_MESSAGE =
  'User Access JWT configuration is invalid';
const INVALID_SIGNING_KEY_MESSAGE =
  `AIHUB_USER_ACCESS_JWT_PRIVATE_KEY must be an RSA key with at least ` +
  `${USER_ACCESS_TOKEN_MINIMUM_RSA_MODULUS_BITS} bits`;

export class JoseUserAccessTokenService
  implements UserAccessTokenIssuerPort, UserAccessTokenVerifierPort
{
  private readonly privateKey: CryptoKey | KeyObject;
  private readonly publicKey: CryptoKey | KeyObject;

  constructor(
    private readonly config: UserAccessTokenConfig,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    if (
      config.privateKeyPem.trim().length === 0 ||
      config.keyId.trim().length === 0 ||
      config.issuer.trim().length === 0 ||
      config.audience.trim().length === 0 ||
      config.expiresInSeconds < 1 ||
      config.expiresInSeconds > 900 ||
      config.clockSkewSeconds < 0
    ) {
      throw new Error('User Access JWT configuration is invalid');
    }

    let privateKey: ReturnType<typeof createPrivateKey>;
    try {
      privateKey = createPrivateKey(config.privateKeyPem);
    } catch {
      throw new Error(INVALID_KEY_CONFIGURATION_MESSAGE);
    }
    if (privateKey.asymmetricKeyType !== 'rsa') {
      throw new Error(INVALID_KEY_CONFIGURATION_MESSAGE);
    }
    if (
      !userAccessTokenRsaModulusIsAcceptable(
        privateKey.asymmetricKeyDetails?.modulusLength,
      )
    ) {
      throw new Error(INVALID_SIGNING_KEY_MESSAGE);
    }
    this.privateKey = privateKey;
    try {
      this.publicKey = createPublicKey(privateKey);
    } catch {
      throw new Error(INVALID_KEY_CONFIGURATION_MESSAGE);
    }
  }

  async issue(userId: string): Promise<IssuedUserAccessToken> {
    if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/u.test(userId)) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'User access token could not be issued',
        retryable: false,
      });
    }

    const issuedAt = this.now();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: this.config.keyId })
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.config.expiresInSeconds)
      .sign(this.privateKey);

    return { token, expiresIn: this.config.expiresInSeconds };
  }

  async verify(token: string): Promise<VerifiedUserAccessToken> {
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== 'RS256' || header.kid !== this.config.keyId) {
        throw invalidUserAccessToken();
      }
      const verified = await jwtVerify(token, this.publicKey, {
        algorithms: ['RS256'],
        issuer: this.config.issuer,
        audience: this.config.audience,
        clockTolerance: this.config.clockSkewSeconds,
      });
      const payload = verified.payload;
      // Unknown claims are ignored so a token from the next release verifies
      // here during a cutover or rollback; every required claim is still checked.
      if (
        typeof payload.iss !== 'string' ||
        typeof payload.aud !== 'string' ||
        payload.aud !== this.config.audience ||
        typeof payload.sub !== 'string' ||
        !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/u.test(payload.sub) ||
        typeof payload.jti !== 'string' ||
        payload.jti.length === 0 ||
        payload.jti.length > 256 ||
        !isSafeInteger(payload.iat) ||
        !isSafeInteger(payload.exp)
      ) {
        throw invalidUserAccessToken();
      }

      const now = this.now();
      if (
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > this.config.expiresInSeconds ||
        payload.iat > now + this.config.clockSkewSeconds ||
        payload.exp < now - this.config.clockSkewSeconds
      ) {
        throw invalidUserAccessToken();
      }

      return { userId: payload.sub, jti: payload.jti };
    } catch {
      throw invalidUserAccessToken();
    }
  }
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
