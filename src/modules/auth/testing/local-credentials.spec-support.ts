import { AppError } from '@/common/errors/app-error';
import type { EmailDeliveryKind } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { EmailOutboxBackpressureGate } from '@/modules/auth/email-delivery/application/email-outbox-backpressure.gate';
import type {
  BackpressureEmailKind,
  EmailOutboxQueueAgePort,
} from '@/modules/auth/email-delivery/application/email-outbox-backpressure.port';
import type { EmailOutboxPort } from '@/modules/auth/email-delivery/application/email-outbox.port';
import { LocalRegistrationService } from '@/modules/auth/local-credentials/application/local-registration.service';
import { LocalSessionService } from '@/modules/auth/local-credentials/application/local-session.service';
import type { PasswordHasherPort } from '@/modules/auth/local-credentials/application/password-hasher.port';
import { PasswordRecoveryService } from '@/modules/auth/local-credentials/application/password-recovery.service';
import type { LocalAccountStatus } from '@/modules/auth/local-credentials/public/local-auth';
import type { AuthMfaServicePort } from '@/modules/auth/mfa/application/auth-mfa-repository.port';
import type {
  IssuedPasswordResetToken,
  PasswordResetTokenPort,
} from '@/modules/auth/password-reset/application/password-reset-token.port';
import type { AuthRateLimiterPort } from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';
import {
  type InMemoryAuthState,
  createInMemoryAuthState,
  seedAccount,
} from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryPasswordResetTokenAdapter } from '@/modules/auth/testing/in-memory-password-reset-token.adapter';
import { InMemoryRefreshSessionAdapter } from '@/modules/auth/testing/in-memory-refresh-session.adapter';
import { InMemoryUserAccountAdapter } from '@/modules/auth/testing/in-memory-user-account.adapter';
import { InMemoryVerificationTokenAdapter } from '@/modules/auth/testing/in-memory-verification-token.adapter';
import type {
  IssuedVerificationToken,
  VerificationTokenPort,
} from '@/modules/auth/verification/application/verification-token.port';
import type {
  IssuedRefreshToken,
  RefreshTokenIssuerPort,
} from '@/modules/auth/web-sessions/application/refresh-token.port';
import type {
  IssuedUserAccessToken,
  UserAccessTokenIssuerPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';

export const USER_ID = 'usr_01J00000000000000000000000';
export const EMAIL = 'person@example.com';
export const NOW = new Date('2026-09-20T00:00:00.000Z');
export const LEGACY_PASSWORD_HASH =
  '$argon2id$v=19$m=8192,p=1,t=1$c2FsdHNhbHQ$aGFzaA';
export const RECOVERY_MESSAGE =
  'If the account exists and is eligible, AIHUB has accepted a request to send password reset instructions.';

export interface SeededAccount {
  readonly userId: string;
  readonly status: LocalAccountStatus;
}

class FakeHasher implements PasswordHasherPort {
  verified: string[] = [];
  hashed: string[] = [];
  result = true;

  async hash(password: string): Promise<string> {
    this.hashed.push(password);
    return `argon2:${password}`;
  }

  async verify(password: string, _encodedHash?: string): Promise<boolean> {
    this.verified.push(password);
    return this.result;
  }

  needsRehash(encodedHash: string): boolean {
    return encodedHash.startsWith('$argon2id$');
  }
}

class FakeTokenIssuer implements VerificationTokenPort {
  issued: IssuedVerificationToken[] = [];
  private sequence = 0;

  issue(now: Date): IssuedVerificationToken {
    this.sequence += 1;
    const raw = `opaque-token-${this.sequence}`;
    const token = {
      id: `evt_${this.sequence}`,
      raw,
      hash: this.hash(raw),
      expiresAt: new Date(now.getTime() + 86_400_000),
    };
    this.issued.push(token);
    return token;
  }

  hash(raw: string): string {
    return `hash:${raw}`;
  }
}

class FakePasswordResetTokenIssuer implements PasswordResetTokenPort {
  issued: IssuedPasswordResetToken[] = [];
  private sequence = 0;

  issue(now: Date): IssuedPasswordResetToken {
    this.sequence += 1;
    const raw = `reset-token-${this.sequence}`;
    const token = {
      id: `prt_${this.sequence}`,
      raw,
      hash: this.hash(raw),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    };
    this.issued.push(token);
    return token;
  }

  hash(raw: string): string {
    return `reset-hash:${raw}`;
  }
}

class FakeAccessTokenIssuer implements UserAccessTokenIssuerPort {
  async issue(userId: string): Promise<IssuedUserAccessToken> {
    return {
      token: `jwt-for-${userId}`,
      expiresIn: 900,
    };
  }
}

class FakeRefreshTokenIssuer implements RefreshTokenIssuerPort {
  private sequence = 0;

  issue(now: Date, familyId?: string): IssuedRefreshToken {
    this.sequence += 1;
    const raw = `refresh-${this.sequence}`;
    return {
      id: `rft_${this.sequence}`,
      familyId: familyId ?? `rfs_${this.sequence}`,
      raw,
      hash: this.hash(raw),
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    };
  }

  hash(raw: string): string {
    return `hash:${raw}`;
  }
}

class FakeLimiter implements AuthRateLimiterPort {
  calls: unknown[] = [];
  allowed = true;

  async check() {
    return { allowed: true };
  }

  async consume(input: Parameters<AuthRateLimiterPort['consume']>[0]) {
    this.calls.push(input);
    return { allowed: this.allowed, retryAfterMs: 1000 };
  }
}

class FakeClock {
  value = new Date(NOW.getTime());

  now(): Date {
    return new Date(this.value);
  }
}

class FakeMfaService implements AuthMfaServicePort {
  result: Awaited<ReturnType<AuthMfaServicePort['loginProof']>> = {
    kind: 'none',
  };

  async loginProof() {
    return this.result;
  }

  async beginEnrollment(): Promise<{
    readonly secret: string;
    readonly otpauthUri: string;
  }> {
    throw new Error('unused');
  }

  async confirmEnrollment(): Promise<readonly string[]> {
    throw new Error('unused');
  }

  async removeFactor(): Promise<void> {
    throw new Error('unused');
  }
}

export function sessionOf(
  outcome: Awaited<ReturnType<LocalSessionService['login']>>,
) {
  if (outcome.kind !== 'session') throw new Error('MFA proof was required');
  return outcome.session;
}

/** The queue age that makes the email outbox refuse new work. */
const BACKLOGGED_SECONDS = 24 * 60 * 60;
export const backlogged = { queueAge: async () => BACKLOGGED_SECONDS };

export async function refusal(attempt: Promise<unknown>): Promise<AppError> {
  const error = await attempt.then(
    () => undefined,
    (rejected: unknown) => rejected,
  );
  if (!(error instanceof AppError)) throw new Error('expected a refusal');
  return error;
}

/** The three local-credential use cases over one in-memory auth state. */
export function localAuth(
  options: {
    readonly requireVerificationPassword?: boolean;
    readonly queueAge?: EmailOutboxQueueAgePort['oldestQueuedAgeSeconds'];
  } = {},
) {
  const refusals: BackpressureEmailKind[] = [];
  const queueAges: EmailDeliveryKind[] = [];
  const state = createInMemoryAuthState();
  const userAccounts = new InMemoryUserAccountAdapter(state);
  const verificationTokens = new InMemoryVerificationTokenAdapter(state);
  const passwordResetTokens = new InMemoryPasswordResetTokenAdapter(state);
  const refreshSessions = new InMemoryRefreshSessionAdapter(state);
  const tokenIssuer = new FakeTokenIssuer();
  const passwordResetTokenIssuer = new FakePasswordResetTokenIssuer();
  const limiter = new FakeLimiter();
  const hasher = new FakeHasher();
  const clock = new FakeClock();
  const mfa = new FakeMfaService();

  const gate = new EmailOutboxBackpressureGate(
    {
      oldestQueuedAgeSeconds: async (kind) => {
        queueAges.push(kind);
        return (options.queueAge ?? (async () => 0))(kind);
      },
    },
    (kind) => refusals.push(kind),
    () => 0,
  );
  const emailOutbox: EmailOutboxPort = {
    withAdmission: async (kind, operation) => {
      await gate.admit(kind);
      return operation();
    },
    reserveAuthenticationEmailRecipient: async () => true,
    queue: async () => undefined,
    withdraw: async () => undefined,
  };
  const credentials = {
    userAccounts,
    passwordHasher: hasher,
    rateLimiter: limiter,
  };
  const sessionIssuers = {
    accessTokens: new FakeAccessTokenIssuer(),
    refreshTokens: new FakeRefreshTokenIssuer(),
  };
  const registration = new LocalRegistrationService(
    credentials,
    verificationTokens,
    tokenIssuer,
    emailOutbox,
    sessionIssuers,
    clock,
    options.requireVerificationPassword ?? false,
  );
  const recovery = new PasswordRecoveryService(
    passwordResetTokens,
    passwordResetTokenIssuer,
    hasher,
    emailOutbox,
    limiter,
    clock,
  );
  const sessions = new LocalSessionService(
    credentials,
    refreshSessions,
    sessionIssuers,
    clock,
    mfa,
  );
  return {
    registration,
    recovery,
    sessions,
    state,
    userAccounts,
    tokenIssuer,
    passwordResetTokenIssuer,
    passwordResetTokens,
    refreshSessions,
    limiter,
    hasher,
    clock,
    mfa,
    refusals,
    queueAges,
  };
}

/** An active account holder who already verified their email. */
export function seedActiveAccount(
  state: InMemoryAuthState,
  passwordHash = 'argon2:correct horse battery',
): void {
  seedAccount(state, {
    userId: USER_ID,
    email: EMAIL,
    username: 'person_01',
    passwordHash,
  });
}

export function setStatus(
  state: InMemoryAuthState,
  status: 'active' | 'disabled',
): void {
  const account = state.accounts.get(USER_ID);
  if (account === undefined) {
    throw new Error('the account was never seeded');
  }
  account.status = status;
}

export function issuedToken(
  issued: readonly { readonly raw: string }[] | undefined,
  index = 0,
): string {
  const token = issued?.[index];
  if (token === undefined) {
    throw new Error(`no token was issued at position ${index}`);
  }
  return token.raw;
}

export function issuedVerificationExpiresAt(
  tokenIssuer: { readonly issued: readonly { readonly expiresAt: Date }[] },
  index = 0,
): string {
  const token = tokenIssuer.issued[index];
  if (token === undefined) {
    throw new Error(`no token was issued at position ${index}`);
  }
  return token.expiresAt.toISOString();
}
