import { AppError } from '@/common/errors/app-error';
import type { IdMinter } from '@/common/ids/prefixed-id';
import type {
  AuthMfaCipherPort,
  AuthMfaRepositoryPort,
  AuthMfaServicePort,
  MfaSessionProof,
} from './auth-mfa-repository.port';
import type { AuthRateLimiterPort } from './auth-rate-limiter.port';
import type {
  EmailPayloadCipherPort,
  InsertEmailDeliveryRequestInput,
} from './email-delivery-request.port';
import type { LocalAuthServiceClock } from './local-auth.service';
import {
  authenticateCredentials,
  rejectCredentials,
} from './local-credentials';
import {
  generateMfaRecoveryCodes,
  generateTotpSecret,
  hashMfaRecoveryCode,
  verifyTotp,
} from './mfa-policy';
import type { PasswordHasherPort } from './password-hasher.port';
import type { UserAccountRepositoryPort } from './user-account.port';

const AUTHENTICATOR_LABEL = 'AIHUB';

function invalidCredentials(): AppError {
  return new AppError({
    code: 'AUTH_CREDENTIALS_INVALID',
    message: 'Email or password is invalid',
    retryable: false,
  });
}

function alreadyEnabled(): AppError {
  return new AppError({
    code: 'AUTH_MFA_ALREADY_ENABLED',
    message:
      'A TOTP factor is already enabled; remove it before enrolling again',
    retryable: false,
  });
}

export class AuthMfaService implements AuthMfaServicePort {
  constructor(
    private readonly repository: AuthMfaRepositoryPort,
    private readonly cipher: AuthMfaCipherPort,
    private readonly userAccounts: UserAccountRepositoryPort,
    private readonly passwordHasher: PasswordHasherPort,
    private readonly rateLimiter: AuthRateLimiterPort,
    private readonly emailCipher: EmailPayloadCipherPort,
    private readonly newEmailDeliveryId: IdMinter,
    private readonly newFactorId: IdMinter,
    private readonly clock: LocalAuthServiceClock,
  ) {}

  async loginProof(
    userId: string,
    code: string | undefined,
  ): Promise<
    | { readonly kind: 'none' }
    | { readonly kind: 'required' }
    | { readonly kind: 'invalid' }
    | { readonly kind: 'proved'; readonly proof: MfaSessionProof }
  > {
    const factor = await this.repository.findActiveFactor(userId);
    if (factor === undefined) {
      return code === undefined ? { kind: 'none' } : { kind: 'invalid' };
    }
    if (code === undefined) return { kind: 'required' };

    const secret = this.cipher.decrypt(factor.keyId, factor.ciphertext, factor);
    if (verifyTotp(secret, code, this.clock.now())) {
      return {
        kind: 'proved',
        proof: { kind: 'totp', factorId: factor.factorId },
      };
    }
    return {
      kind: 'proved',
      proof: { kind: 'recovery', codeHash: hashMfaRecoveryCode(code) },
    };
  }

  async beginEnrollment(input: {
    readonly userId: string;
    readonly password: string;
    readonly ip: string;
  }): Promise<{ readonly secret: string; readonly otpauthUri: string }> {
    const credentials = await authenticateCredentials(
      {
        userAccounts: this.userAccounts,
        passwordHasher: this.passwordHasher,
        rateLimiter: this.rateLimiter,
      },
      {
        email: await this.emailForUser(input.userId),
        password: input.password,
      },
      input.ip,
    );
    if (credentials.userId !== input.userId) {
      return rejectCredentials(this.rateLimiter, input.ip, credentials.email);
    }

    const secret = generateTotpSecret();
    const factorId = this.newFactorId(this.clock.now());
    const encrypted = this.cipher.encrypt(secret, {
      userId: input.userId,
      factorId,
    });
    const saved = await this.repository.savePendingFactor({
      factorId,
      userId: input.userId,
      expectedPasswordHash: credentials.passwordHash,
      keyId: encrypted.keyId,
      ciphertext: encrypted.ciphertext,
      now: this.clock.now(),
    });
    if (!saved) throw alreadyEnabled();

    const label = encodeURIComponent(
      `${AUTHENTICATOR_LABEL}:${credentials.email}`,
    );
    const otpauthUri = `otpauth://totp/${label}?secret=${secret}&issuer=${AUTHENTICATOR_LABEL}&algorithm=SHA1&digits=6&period=30`;
    return { secret, otpauthUri };
  }

  async confirmEnrollment(input: {
    readonly userId: string;
    readonly code: string;
    readonly ip: string;
  }): Promise<readonly string[]> {
    const factor = await this.repository.findPendingFactor(input.userId);
    if (factor === undefined) throw invalidCredentials();
    const secret = this.cipher.decrypt(factor.keyId, factor.ciphertext, factor);
    if (!verifyTotp(secret, input.code, this.clock.now())) {
      return rejectCredentials(this.rateLimiter, input.ip, factor.email);
    }

    const recoveryCodes = generateMfaRecoveryCodes();
    const now = this.clock.now();
    const confirmed = await this.repository.confirmFactor({
      factorId: factor.factorId,
      userId: input.userId,
      email: factor.email,
      recoveryCodeHashes: recoveryCodes.map(hashMfaRecoveryCode),
      emailDelivery: this.emailDelivery(
        'mfa_enabled_notification',
        { email: factor.email },
        now,
      ),
      now,
    });
    if (!confirmed) throw invalidCredentials();
    return recoveryCodes;
  }

  async removeFactor(input: {
    readonly userId: string;
    readonly proof: { readonly password: string } | { readonly code: string };
    readonly ip: string;
  }): Promise<void> {
    const factor = await this.repository.findActiveFactor(input.userId);
    let email = factor?.email;
    let expectedPasswordHash: string | undefined;
    if ('password' in input.proof) {
      const credentials = await authenticateCredentials(
        {
          userAccounts: this.userAccounts,
          passwordHasher: this.passwordHasher,
          rateLimiter: this.rateLimiter,
        },
        {
          email: await this.emailForUser(input.userId),
          password: input.proof.password,
        },
        input.ip,
      );
      if (credentials.userId !== input.userId) {
        return rejectCredentials(this.rateLimiter, input.ip, credentials.email);
      }
      email = credentials.email;
      expectedPasswordHash = credentials.passwordHash;
    } else {
      if (factor === undefined) throw invalidCredentials();
      const secret = this.cipher.decrypt(
        factor.keyId,
        factor.ciphertext,
        factor,
      );
      if (!verifyTotp(secret, input.proof.code, this.clock.now())) {
        return rejectCredentials(this.rateLimiter, input.ip, factor.email);
      }
      email = factor.email;
    }

    const now = this.clock.now();
    const removed = await this.repository.removeFactor({
      factorId: factor?.factorId,
      userId: input.userId,
      email: email ?? '',
      ...(expectedPasswordHash === undefined ? {} : { expectedPasswordHash }),
      emailDelivery:
        factor === undefined
          ? undefined
          : this.emailDelivery(
              'mfa_removed_notification',
              { email: factor.email },
              now,
            ),
      now,
    });
    if (!removed) throw invalidCredentials();
  }

  private async emailForUser(userId: string): Promise<string> {
    const identity = await this.userAccounts.findLoginIdentityByUserId(userId);
    if (identity === undefined || identity.status !== 'active') {
      throw invalidCredentials();
    }
    return identity.email;
  }

  private emailDelivery(
    kind: 'mfa_enabled_notification' | 'mfa_removed_notification',
    payload: { readonly email: string },
    now: Date,
  ): InsertEmailDeliveryRequestInput {
    return {
      id: this.newEmailDeliveryId(now),
      kind,
      payloadCiphertext: this.emailCipher.encrypt(JSON.stringify(payload)),
      createdAt: now,
    };
  }
}
