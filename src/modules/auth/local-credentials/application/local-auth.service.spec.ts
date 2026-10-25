import { AppError } from '@/common/errors/app-error';
import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import type { LocalAccountStatus } from '@/modules/auth/domain/local-auth';
import type {
  EmailDeliveryKind,
  EmailPayloadCipherPort,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { EmailOutboxBackpressureGate } from '@/modules/auth/email-delivery/application/email-outbox-backpressure.gate';
import type {
  BackpressureEmailKind,
  EmailOutboxQueueAgePort,
} from '@/modules/auth/email-delivery/application/email-outbox-backpressure.port';
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
import { LocalAuthService } from './local-auth.service';
import type { PasswordHasherPort } from './password-hasher.port';

const USER_ID = 'usr_01J00000000000000000000000';
const EMAIL = 'person@example.com';
const NOW = new Date('2026-09-20T00:00:00.000Z');
const LEGACY_PASSWORD_HASH = '$argon2id$v=19$m=8192,p=1,t=1$c2FsdHNhbHQ$aGFzaA';
const RECOVERY_MESSAGE =
  'If the account exists and is eligible, AIHUB has accepted a request to send password reset instructions.';

interface SeededAccount {
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

/**
 * Reversible so a test can read what the worker would later read back out of
 * the ciphertext. The real cipher is exercised by its own spec.
 */
class FakeCipher implements EmailPayloadCipherPort {
  sealed: string[] = [];

  encrypt(plaintext: string): string {
    this.sealed.push(plaintext);
    return `sealed:${Buffer.from(plaintext, 'utf8').toString('base64url')}`;
  }

  decrypt(envelope: string): string {
    return Buffer.from(envelope.slice('sealed:'.length), 'base64url').toString(
      'utf8',
    );
  }
}

interface SealedEmailDelivery {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: string;
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

function sessionOf(outcome: Awaited<ReturnType<LocalAuthService['login']>>) {
  if (outcome.kind !== 'session') throw new Error('MFA proof was required');
  return outcome.session;
}

function service(
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
  const cipher = new FakeCipher();
  const limiter = new FakeLimiter();
  const hasher = new FakeHasher();
  const clock = new FakeClock();
  const mfa = new FakeMfaService();

  const local = new LocalAuthService(
    userAccounts,
    verificationTokens,
    passwordResetTokens,
    refreshSessions,
    hasher,
    tokenIssuer,
    passwordResetTokenIssuer,
    cipher,
    limiter,
    new FakeAccessTokenIssuer(),
    new FakeRefreshTokenIssuer(),
    clock,
    prefixedIdGenerator('edr_'),
    mfa,
    new EmailOutboxBackpressureGate(
      {
        oldestQueuedAgeSeconds: async (kind) => {
          queueAges.push(kind);
          return (options.queueAge ?? (async () => 0))(kind);
        },
      },
      (kind) => refusals.push(kind),
      () => 0,
    ),
    options.requireVerificationPassword ?? false,
  );
  return {
    local,
    state,
    userAccounts,
    tokenIssuer,
    passwordResetTokenIssuer,
    passwordResetTokens,
    refreshSessions,
    cipher,
    limiter,
    hasher,
    clock,
    mfa,
    refusals,
    queueAges,
  };
}

/** An active account holder who already verified their email. */
function seedActiveAccount(
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

function setStatus(
  state: InMemoryAuthState,
  status: 'active' | 'disabled',
): void {
  const account = state.accounts.get(USER_ID);
  if (account === undefined) {
    throw new Error('the account was never seeded');
  }
  account.status = status;
}

function issuedToken(
  issued: readonly { readonly raw: string }[] | undefined,
  index = 0,
): string {
  const token = issued?.[index];
  if (token === undefined) {
    throw new Error(`no token was issued at position ${index}`);
  }
  return token.raw;
}

/** What the worker would read back out of the ciphertext once it claims a row. */
function sealed(
  cipher: FakeCipher,
  request: { readonly payloadCiphertext: string } | undefined,
): SealedEmailDelivery {
  if (request === undefined) {
    throw new Error('no email delivery request was written');
  }
  return JSON.parse(
    cipher.decrypt(request.payloadCiphertext),
  ) as SealedEmailDelivery;
}

function issuedVerificationExpiresAt(
  tokenIssuer: { readonly issued: readonly { readonly expiresAt: Date }[] },
  index = 0,
): string {
  const token = tokenIssuer.issued[index];
  if (token === undefined) {
    throw new Error(`no token was issued at position ${index}`);
  }
  return token.expiresAt.toISOString();
}

describe('LocalAuthService', () => {
  describe('email outbox backpressure', () => {
    const BACKLOGGED = 24 * 60 * 60;
    const backlogged = { queueAge: async () => BACKLOGGED };

    async function refusal(attempt: Promise<unknown>): Promise<AppError> {
      const error = await attempt.then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
      if (!(error instanceof AppError)) throw new Error('expected a refusal');
      return error;
    }

    it('refuses a registration with a retryable 503 before any rate limit or durable write', async () => {
      const { local, state, limiter, refusals } = service(backlogged);

      const error = await refusal(
        local.register(
          { email: EMAIL, username: 'person_01', password: 'exact password' },
          '203.0.113.7',
        ),
      );

      expect(error).toMatchObject({
        code: 'EMAIL_DELIVERY_BACKLOGGED',
        httpStatus: 503,
        retryable: true,
      });
      expect(error.retryAfterMs).toBeGreaterThan(0);
      expect(limiter.calls).toEqual([]);
      expect(state.accounts.size).toBe(0);
      expect(state.verificationTokens.size).toBe(0);
      expect(state.emailDeliveryRequests).toEqual([]);
      expect(refusals).toEqual(['verification_email']);
    });

    it('refuses a verification resend the same way, without spending its limits', async () => {
      const { local, state, limiter, refusals } = service(backlogged);

      await expect(
        refusal(local.resend(EMAIL, '203.0.113.7')),
      ).resolves.toMatchObject({ code: 'EMAIL_DELIVERY_BACKLOGGED' });

      expect(limiter.calls).toEqual([]);
      expect(state.emailDeliveryRequests).toEqual([]);
      expect(refusals).toEqual(['verification_email']);
    });

    it('refuses a password recovery request for every address, known or not', async () => {
      const { local, state, limiter, refusals } = service(backlogged);
      seedActiveAccount(state);

      await expect(
        refusal(local.forgotPassword({ email: EMAIL }, '203.0.113.7')),
      ).resolves.toMatchObject({ code: 'EMAIL_DELIVERY_BACKLOGGED' });
      await expect(
        refusal(
          local.forgotPassword({ email: 'nobody@example.com' }, '203.0.113.7'),
        ),
      ).resolves.toMatchObject({ code: 'EMAIL_DELIVERY_BACKLOGGED' });

      expect(limiter.calls).toEqual([]);
      expect(state.passwordResetTokens.size).toBe(0);
      expect(state.emailDeliveryRequests).toEqual([]);
      expect(refusals).toEqual([
        'password_reset_email',
        'password_reset_email',
      ]);
    });

    it('proceeds as before when the queue age cannot be read', async () => {
      const { local, state, limiter, refusals } = service({
        queueAge: async () => {
          throw new Error('database down');
        },
      });

      await local.register(
        { email: EMAIL, username: 'person_01', password: 'exact password' },
        '203.0.113.7',
      );

      expect(state.emailDeliveryRequests).toHaveLength(1);
      expect(limiter.calls).toHaveLength(2);
      expect(refusals).toEqual([]);
    });

    it('does not ask about the queue for an invalid request', async () => {
      const { local, queueAges } = service(backlogged);

      await expect(
        local.register(
          { email: 'not an email', username: 'person_01', password: 'x' },
          '203.0.113.7',
        ),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

      expect(queueAges).toEqual([]);
    });
  });

  it('registers a canonical pending account and queues its verification email', async () => {
    const { local, state, cipher, limiter, tokenIssuer } = service();

    await expect(
      local.register(
        {
          email: ' Person@Example.com ',
          username: ' Person_01 ',
          password: '  exact password  ',
        },
        '203.0.113.7',
      ),
    ).resolves.toEqual({
      email: 'person@example.com',
      username: 'person_01',
      status: 'pending_verification',
      emailDeliveryStatus: 'queued',
    });
    expect([...state.accounts.values()]).toEqual([
      expect.objectContaining({
        email: 'person@example.com',
        username: 'person_01',
        status: 'pending_verification',
        passwordHash: 'argon2:  exact password  ',
      }),
    ]);
    expect([...state.verificationTokens.keys()]).toEqual([
      tokenIssuer.hash('opaque-token-1'),
    ]);
    // One durable handoff, carrying the opaque token and nothing else.
    expect(state.emailDeliveryRequests).toHaveLength(1);
    expect(state.emailDeliveryRequests[0]).toMatchObject({
      kind: 'verification_email',
      id: expect.stringMatching(/^edr_[0-9A-HJKMNP-TV-Z]{26}$/),
      createdAt: NOW,
    });
    expect(sealed(cipher, state.emailDeliveryRequests[0])).toEqual({
      email: 'person@example.com',
      token: 'opaque-token-1',
      expiresAt: issuedVerificationExpiresAt(tokenIssuer),
    });
    expect(limiter.calls).toHaveLength(2);
  });

  it('reports an active account or a username held by another account as the one generic identity conflict', async () => {
    const { local, state } = service();
    const input = {
      email: 'person@example.com',
      username: 'person_01',
      password: 'correct horse battery',
    };
    await local.register(input, '203.0.113.7');
    const [account] = [...state.accounts.values()];
    if (account === undefined) throw new Error('no account was registered');
    account.status = 'active';

    await expect(local.register(input, '203.0.113.7')).rejects.toMatchObject({
      code: 'AUTH_IDENTITY_UNAVAILABLE',
      httpStatus: 409,
    });
    await expect(
      local.register({ ...input, email: 'other@example.com' }, '203.0.113.7'),
    ).rejects.toMatchObject({
      code: 'AUTH_IDENTITY_UNAVAILABLE',
      httpStatus: 409,
    });
    expect(state.accounts.size).toBe(1);
    expect(state.emailDeliveryRequests).toHaveLength(1);
  });

  describe('one address has one form (#394)', () => {
    const input = { username: 'person_01', password: 'correct horse battery' };

    it('treats the Unicode and punycode spellings of one domain as one account', async () => {
      const { local, state } = service();
      await local.register(
        { ...input, email: 'user@bücher.de' },
        '203.0.113.7',
      );
      const [account] = [...state.accounts.values()];
      if (account === undefined) throw new Error('no account was registered');
      account.status = 'active';

      await expect(
        local.register(
          { ...input, username: 'person_02', email: 'USER@xn--bcher-kva.de' },
          '203.0.113.7',
        ),
      ).rejects.toMatchObject({ code: 'AUTH_IDENTITY_UNAVAILABLE' });
      expect(
        [...state.accounts.values()].map((stored) => stored.email),
      ).toEqual(['user@xn--bcher-kva.de']);
    });

    it('refuses a look-alike address on every email route with the same validation error', async () => {
      const { local, state, limiter, queueAges } = service();
      const lookAlike = 'user@аpple.com';

      await expect(
        local.register({ ...input, email: lookAlike }, '203.0.113.7'),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(
        local.resend(lookAlike, '203.0.113.7'),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(
        local.forgotPassword({ email: lookAlike }, '203.0.113.7'),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(limiter.calls).toEqual([]);
      expect(queueAges).toEqual([]);
      expect(state.accounts.size).toBe(0);
    });
  });

  describe('registering again on a pending email', () => {
    const first = {
      email: 'person@example.com',
      username: 'person_01',
      password: 'first password value',
    };
    const second = {
      email: 'person@example.com',
      username: 'person_02',
      password: 'second password value',
    };

    it('replaces the pending credential and username and supersedes the open token', async () => {
      const { local, state, tokenIssuer } = service();
      await local.register(first, '203.0.113.7');

      await local.register(second, '203.0.113.7');

      expect([...state.accounts.values()]).toEqual([
        expect.objectContaining({
          email: 'person@example.com',
          username: 'person_02',
          status: 'pending_verification',
          passwordHash: 'argon2:second password value',
        }),
      ]);
      expect([...state.verificationTokens.entries()]).toEqual([
        [
          tokenIssuer.hash('opaque-token-1'),
          expect.objectContaining({ consumedReason: 'superseded' }),
        ],
        [
          tokenIssuer.hash('opaque-token-2'),
          expect.objectContaining({ consumedReason: undefined }),
        ],
      ]);
      expect(state.emailDeliveryRequests).toHaveLength(2);
    });

    it('answers exactly as it does for an email nobody has registered', async () => {
      const fresh = service();
      const replaced = service();
      await replaced.local.register(first, '203.0.113.7');

      const answerForNewEmail = await fresh.local.register(
        second,
        '203.0.113.8',
      );
      const answerForPendingEmail = await replaced.local.register(
        second,
        '203.0.113.7',
      );

      expect(answerForPendingEmail).toEqual(answerForNewEmail);
    });

    it('leaves the pending account unchanged when the new username is held by another account', async () => {
      const { local, state } = service();
      await local.register(first, '203.0.113.7');
      await local.register(
        { ...first, email: 'other@example.com', username: 'person_02' },
        '203.0.113.7',
      );

      await expect(local.register(second, '203.0.113.7')).rejects.toMatchObject(
        { code: 'AUTH_IDENTITY_UNAVAILABLE' },
      );

      expect(
        [...state.accounts.values()].find(
          (account) => account.email === 'person@example.com',
        ),
      ).toMatchObject({
        username: 'person_01',
        passwordHash: 'argon2:first password value',
      });
    });
  });

  it('returns a generic resend result for unknown addresses', async () => {
    const { local, state } = service();

    await expect(
      local.resend('nobody@example.com', '203.0.113.7'),
    ).resolves.toBe(undefined);
    expect(state.verificationTokens.size).toBe(0);
    expect(state.emailDeliveryRequests).toHaveLength(0);
  });

  it('queues the replacement verification email with the rotation', async () => {
    const { local, state, cipher, tokenIssuer } = service();
    await local.register(
      {
        email: EMAIL,
        username: 'person_01',
        password: 'correct horse battery',
      },
      '203.0.113.7',
    );

    await expect(
      local.resend(' Person@Example.com ', '203.0.113.7'),
    ).resolves.toBe(undefined);

    expect(state.emailDeliveryRequests).toHaveLength(2);
    const resend = state.emailDeliveryRequests[1];
    expect(resend?.kind).toBe('verification_email');
    expect(sealed(cipher, resend)).toEqual({
      email: EMAIL,
      token: 'opaque-token-2',
      expiresAt: issuedVerificationExpiresAt(tokenIssuer, 1),
    });
    // The superseded token and the fresh request commit as one unit.
    expect(
      [...state.verificationTokens.values()].map(
        (token) => token.consumedReason,
      ),
    ).toEqual(['superseded', undefined]);
  });

  it('returns one recovery message for an active target and keeps its rate limits', async () => {
    const { local, state, cipher, limiter, passwordResetTokenIssuer } =
      service();
    seedActiveAccount(state);

    await expect(
      local.forgotPassword({ email: ' Person@Example.com ' }, '203.0.113.7'),
    ).resolves.toEqual({ message: RECOVERY_MESSAGE });
    expect([...state.passwordResetTokens.keys()]).toEqual([
      passwordResetTokenIssuer.hash('reset-token-1'),
    ]);
    expect(state.emailDeliveryRequests).toHaveLength(1);
    expect(sealed(cipher, state.emailDeliveryRequests[0])).toEqual({
      email: EMAIL,
      token: 'reset-token-1',
      expiresAt: passwordResetTokenIssuer.issued[0]?.expiresAt.toISOString(),
    });
    expect(limiter.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'forgot_ip',
          limit: 3,
          windowMs: 900000,
        }),
        expect.objectContaining({
          scope: 'auth_email_request',
          limit: 3,
          windowMs: 86400000,
        }),
      ]),
    );
  });

  it.each([
    ['unknown', undefined],
    ['pending', 'pending_verification'],
    ['disabled', 'disabled'],
  ] as const)(
    'accepts a conditional send for a %s account without writing a request',
    async (_label, status) => {
      const { local, state } = service();
      if (status !== undefined) {
        seedAccount(state, {
          userId: USER_ID,
          email: EMAIL,
          username: 'person_01',
          passwordHash: 'argon2:correct horse battery',
          status,
        });
      }

      await expect(
        local.forgotPassword({ email: EMAIL }, '203.0.113.7'),
      ).resolves.toEqual({ message: RECOVERY_MESSAGE });
      expect(state.passwordResetTokens.size).toBe(0);
      expect(state.emailDeliveryRequests).toHaveLength(0);
    },
  );

  it.each([11, 129])(
    'returns a generic invalid request for a %i-code-point reset password',
    async (length) => {
      const { local } = service();

      await expect(
        local.resetPassword(
          { token: 'reset-token-1', password: 'a'.repeat(length) },
          '203.0.113.7',
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        httpStatus: 400,
      });
    },
  );

  it('resets once, then maps the replayed token to one public error that counts as a failure', async () => {
    const { local, state, limiter, hasher, passwordResetTokenIssuer } =
      service();
    seedActiveAccount(state);
    await local.forgotPassword({ email: EMAIL }, '203.0.113.7');
    const token = issuedToken(passwordResetTokenIssuer.issued);

    await expect(
      local.resetPassword(
        { token, password: 'new password that works' },
        '203.0.113.7',
      ),
    ).resolves.toBeUndefined();
    expect(hasher.hashed).toEqual(['new password that works']);
    expect(limiter.calls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'reset_ip' }),
        expect.objectContaining({ scope: 'reset_token' }),
      ]),
    );
    expect(state.accounts.get(USER_ID)?.passwordHash).toBe(
      'argon2:new password that works',
    );

    await expect(
      local.resetPassword(
        { token, password: 'another password here' },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({
      code: 'AUTH_PASSWORD_RESET_TOKEN_INVALID',
      httpStatus: 400,
    });
    expect(hasher.hashed).toHaveLength(1);
    expect(limiter.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'reset_ip',
          limit: 10,
          windowMs: 300000,
        }),
        expect.objectContaining({
          scope: 'reset_token',
          limit: 5,
          windowMs: 900000,
        }),
      ]),
    );
  });

  it('uses one generic invalid result for an unknown verification token', async () => {
    const { local } = service();

    await expect(
      local.verify('bad-token', '203.0.113.7'),
    ).rejects.toMatchObject({
      code: 'AUTH_VERIFICATION_TOKEN_INVALID',
    });
  });

  describe('verification password (ADR-0123)', () => {
    const registration = {
      email: EMAIL,
      username: 'person_01',
      password: 'correct horse battery',
    };

    async function registered(requireVerificationPassword: boolean) {
      const context = service({ requireVerificationPassword });
      // The shared fake accepts any password; these tests need it to compare.
      context.hasher.verify = async (password, encodedHash) =>
        encodedHash === `argon2:${password}`;
      await context.local.register(registration, '203.0.113.7');
      return { ...context, rawToken: issuedToken(context.tokenIssuer.issued) };
    }

    function accountStatus(context: { state: InMemoryAuthState }) {
      return [...context.state.accounts.values()][0]?.status;
    }

    it('marks the token of a registration made while the setting is on', async () => {
      const { state } = await registered(true);

      expect(
        [...state.verificationTokens.values()].map((t) => t.requiresPassword),
      ).toEqual([true]);
    });

    it('marks no token while the setting is off', async () => {
      const { state } = await registered(false);

      expect(
        [...state.verificationTokens.values()].map((t) => t.requiresPassword),
      ).toEqual([false]);
    });

    it('refuses a token that needs the password when none is sent, and verifies with it', async () => {
      const context = await registered(true);

      await expect(
        context.local.verify(context.rawToken, '203.0.113.7'),
      ).rejects.toMatchObject({ code: 'AUTH_VERIFICATION_PASSWORD_INVALID' });
      expect(accountStatus(context)).toBe('pending_verification');

      await expect(
        context.local.verify(
          context.rawToken,
          '203.0.113.7',
          undefined,
          registration.password,
        ),
      ).resolves.toBeUndefined();
      expect(accountStatus(context)).toBe('active');
    });

    it('counts wrong passwords and spends the token on the fifth', async () => {
      const context = await registered(true);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          context.local.verify(
            context.rawToken,
            '203.0.113.7',
            undefined,
            'a wrong password',
          ),
        ).rejects.toMatchObject({ code: 'AUTH_VERIFICATION_PASSWORD_INVALID' });
      }

      await expect(
        context.local.verify(
          context.rawToken,
          '203.0.113.7',
          undefined,
          registration.password,
        ),
      ).rejects.toMatchObject({ code: 'AUTH_VERIFICATION_TOKEN_INVALID' });
      expect(accountStatus(context)).toBe('pending_verification');
    });

    it('verifies a token that does not need the password with or without one, but refuses a wrong one', async () => {
      const context = await registered(false);

      await expect(
        context.local.verify(
          context.rawToken,
          '203.0.113.7',
          undefined,
          'a wrong password',
        ),
      ).rejects.toMatchObject({ code: 'AUTH_VERIFICATION_PASSWORD_INVALID' });
      await expect(
        context.local.verify(context.rawToken, '203.0.113.7'),
      ).resolves.toBeUndefined();
      expect(accountStatus(context)).toBe('active');
    });

    it('issues a resent token that needs the password while the setting is on', async () => {
      const context = await registered(true);

      await context.local.resend(EMAIL, '203.0.113.7');

      expect(
        [...context.state.verificationTokens.values()].map((t) => [
          t.consumedReason,
          t.requiresPassword,
        ]),
      ).toEqual([
        ['superseded', true],
        [undefined, true],
      ]);
    });

    it('needs the password of the latest registration after a pending email registers again', async () => {
      const context = await registered(true);
      const firstToken = context.rawToken;
      await context.local.register(
        {
          ...registration,
          username: 'person_02',
          password: 'second password!',
        },
        '203.0.113.7',
      );
      const secondToken = issuedToken(context.tokenIssuer.issued, 1);

      await expect(
        context.local.verify(
          firstToken,
          '203.0.113.7',
          undefined,
          registration.password,
        ),
      ).rejects.toMatchObject({ code: 'AUTH_VERIFICATION_TOKEN_INVALID' });
      await expect(
        context.local.verify(
          secondToken,
          '203.0.113.7',
          undefined,
          registration.password,
        ),
      ).rejects.toMatchObject({ code: 'AUTH_VERIFICATION_PASSWORD_INVALID' });
      await expect(
        context.local.verify(
          secondToken,
          '203.0.113.7',
          undefined,
          'second password!',
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('Verification Sign-in', () => {
    const binding = 'b'.repeat(43);

    async function registerBound(context: ReturnType<typeof service>) {
      await context.local.register(
        {
          email: EMAIL,
          username: 'person_01',
          password: 'correct horse battery',
        },
        '203.0.113.7',
        binding,
      );
      return issuedToken(context.tokenIssuer.issued);
    }

    it('stores only the hash of the Signup Browser Binding', async () => {
      const context = service();
      await registerBound(context);
      await context.local.resend(EMAIL, '203.0.113.7', binding);
      const resend = issuedToken(context.tokenIssuer.issued, 1);
      await context.local.verify(resend, '203.0.113.7', binding);

      const stored = [...context.state.verificationTokens.values()];
      expect(stored).toHaveLength(2);
      for (const persisted of stored) {
        expect(persisted.browserBindingHash).toBe(`hash:${binding}`);
      }
      expect(JSON.stringify(stored)).not.toContain(`"${binding}"`);
    });

    it('returns no session when the browser binding does not match', async () => {
      const context = service();
      const token = await registerBound(context);

      await expect(
        context.local.verify(token, '203.0.113.7'),
      ).resolves.toBeUndefined();
      expect(context.state.refreshTokens.size).toBe(0);
      expect(
        [...context.state.verificationTokens.values()][0]?.signedInAt,
      ).toBeUndefined();
    });

    it('leaves the bound browser its sign-in after another device verifies', async () => {
      const context = service();
      const token = await registerBound(context);

      await expect(
        context.local.verify(token, '203.0.113.7'),
      ).resolves.toBeUndefined();
      await expect(
        context.local.verify(token, '203.0.113.7', binding),
      ).resolves.toEqual({
        accessToken: 'jwt-for-usr_in_memory_1',
        expiresIn: 900,
        refreshToken: 'refresh-2',
      });
    });

    it('issues a login-equivalent session once, committed with the claim', async () => {
      const context = service();
      const token = await registerBound(context);

      await expect(
        context.local.verify(token, '203.0.113.7', binding),
      ).resolves.toEqual({
        accessToken: 'jwt-for-usr_in_memory_1',
        expiresIn: 900,
        refreshToken: 'refresh-1',
      });
      expect([...context.state.refreshTokens.values()]).toEqual([
        expect.objectContaining({ userId: 'usr_in_memory_1' }),
      ]);

      await expect(
        context.local.verify(token, '203.0.113.7', binding),
      ).resolves.toBeUndefined();
      expect(context.state.refreshTokens.size).toBe(1);
    });
  });

  it('issues an access token only for an active account and does not count success', async () => {
    const { local, state, limiter, hasher } = service();
    seedActiveAccount(state);

    await expect(
      local.login(
        { email: ' Person@Example.com ', password: '  exact password  ' },
        '203.0.113.7',
      ),
    ).resolves.toEqual({
      kind: 'session',
      session: {
        accessToken: `jwt-for-${USER_ID}`,
        expiresIn: 900,
        refreshToken: 'refresh-1',
      },
    });
    expect(hasher.verified).toEqual(['  exact password  ']);
    expect(limiter.calls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'login_ip' }),
        expect.objectContaining({ scope: 'login_email' }),
      ]),
    );
  });

  it('upgrades a legacy password hash after successful login before creating the session', async () => {
    const { local, state } = service();
    seedActiveAccount(state, LEGACY_PASSWORD_HASH);

    await expect(
      local.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    ).resolves.toMatchObject({ kind: 'session' });

    expect(state.accounts.get(USER_ID)?.passwordHash).toBe(
      'argon2:correct horse battery',
    );
    expect(state.refreshTokens.size).toBe(1);
  });

  it('does not rewrite a legacy hash for an incorrect password', async () => {
    const { local, state, hasher } = service();
    seedActiveAccount(state, LEGACY_PASSWORD_HASH);
    hasher.result = false;

    await expect(
      local.login({ email: EMAIL, password: 'wrong password' }, '203.0.113.7'),
    ).rejects.toMatchObject({ code: 'AUTH_CREDENTIALS_INVALID' });

    expect(state.accounts.get(USER_ID)?.passwordHash).toBe(
      LEGACY_PASSWORD_HASH,
    );
    expect(state.refreshTokens.size).toBe(0);
    expect(hasher.hashed).toEqual([]);
  });

  it('does not overwrite a password reset that wins before the hash upgrade', async () => {
    const { local, state, hasher } = service();
    seedActiveAccount(state, LEGACY_PASSWORD_HASH);
    const account = state.accounts.get(USER_ID);
    if (account === undefined) throw new Error('the account was not seeded');
    jest.spyOn(hasher, 'needsRehash').mockImplementation(() => {
      account.passwordHash = 'argon2:reset password';
      return true;
    });

    await expect(
      local.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({ code: 'AUTH_CREDENTIALS_INVALID' });

    expect(account.passwordHash).toBe('argon2:reset password');
    expect(state.refreshTokens.size).toBe(0);
  });

  it('creates no session when saving a replacement password hash fails', async () => {
    const { local, state, userAccounts } = service();
    seedActiveAccount(state, LEGACY_PASSWORD_HASH);
    const update = jest
      .spyOn(userAccounts, 'updatePasswordHash')
      .mockRejectedValue(new Error('storage unavailable'));

    await expect(
      local.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    ).rejects.toThrow('storage unavailable');

    expect(state.accounts.get(USER_ID)?.passwordHash).toBe(
      LEGACY_PASSWORD_HASH,
    );
    expect(state.refreshTokens.size).toBe(0);
    update.mockRestore();
  });

  it('requires an MFA proof before writing a session and counts invalid proof generically', async () => {
    const required = service();
    seedActiveAccount(required.state, LEGACY_PASSWORD_HASH);
    required.state.mfaFactors.set(USER_ID, {
      factorId: 'mfa_01J00000000000000000000000',
      status: 'enabled',
      email: EMAIL,
      secret: 'encrypted',
    });
    required.mfa.result = { kind: 'required' };

    await expect(
      required.local.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    ).resolves.toEqual({ kind: 'mfa-required' });
    expect(required.state.refreshTokens.size).toBe(0);
    expect(required.state.accounts.get(USER_ID)?.passwordHash).toBe(
      LEGACY_PASSWORD_HASH,
    );

    required.mfa.result = { kind: 'invalid' };
    await expect(
      required.local.login(
        { email: EMAIL, password: 'correct horse battery', mfa_code: 'bad' },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({
      code: 'AUTH_CREDENTIALS_INVALID',
      httpStatus: 401,
    });
    expect(required.state.accounts.get(USER_ID)?.passwordHash).toBe(
      LEGACY_PASSWORD_HASH,
    );
    expect(required.limiter.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'login_ip' }),
        expect.objectContaining({ scope: 'login_email' }),
      ]),
    );
  });

  it('consumes a recovery code only in the same write that creates its session', async () => {
    const context = service();
    seedActiveAccount(context.state);
    const factorId = 'mfa_01J00000000000000000000000';
    const codeHash = 'a'.repeat(64);
    context.state.mfaFactors.set(USER_ID, {
      factorId,
      status: 'enabled',
      email: EMAIL,
      secret: 'encrypted',
    });
    context.state.recoveryCodes.set(USER_ID, new Set([codeHash]));
    context.mfa.result = {
      kind: 'proved',
      proof: { kind: 'recovery', codeHash },
    };

    await expect(
      context.local.login(
        { email: EMAIL, password: 'correct horse battery', mfa_code: 'ABCD' },
        '203.0.113.7',
      ),
    ).resolves.toMatchObject({ kind: 'session' });
    expect(context.state.recoveryCodes.get(USER_ID)?.has(codeHash)).toBe(false);
    expect(context.state.refreshTokens.size).toBe(1);

    await expect(
      context.local.login(
        { email: EMAIL, password: 'correct horse battery', mfa_code: 'ABCD' },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({ code: 'AUTH_CREDENTIALS_INVALID' });
    expect(context.state.refreshTokens.size).toBe(1);
  });

  it('accepts a TOTP proof only for the matching active factor', async () => {
    const context = service();
    seedActiveAccount(context.state);
    const factorId = 'mfa_01J00000000000000000000000';
    context.state.mfaFactors.set(USER_ID, {
      factorId,
      status: 'enabled',
      email: EMAIL,
      secret: 'encrypted',
    });
    context.mfa.result = {
      kind: 'proved',
      proof: { kind: 'totp', factorId },
    };

    await expect(
      context.local.login(
        { email: EMAIL, password: 'correct horse battery', mfa_code: '123456' },
        '203.0.113.7',
      ),
    ).resolves.toMatchObject({ kind: 'session' });
    expect(context.state.refreshTokens.size).toBe(1);
  });

  it.each<[string, SeededAccount | undefined]>([
    ['unknown email', undefined],
    [
      'pending account',
      { userId: 'usr_pending', status: 'pending_verification' },
    ],
    ['disabled account', { userId: 'usr_disabled', status: 'disabled' }],
  ])('returns one generic credential error for %s', async (_label, seeded) => {
    const { local, state, limiter, hasher } = service();
    if (seeded !== undefined) {
      seedAccount(state, {
        userId: seeded.userId,
        email: EMAIL,
        username: 'person_01',
        passwordHash: 'hash',
        status: seeded.status,
      });
    }
    hasher.result = false;

    await expect(
      local.login({ email: EMAIL, password: 'wrong password' }, '203.0.113.7'),
    ).rejects.toMatchObject({
      code: 'AUTH_CREDENTIALS_INVALID',
      httpStatus: 401,
    });
    expect(hasher.verified).toHaveLength(1);
    expect(limiter.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'login_ip',
          limit: 20,
          windowMs: 300000,
        }),
        expect.objectContaining({
          scope: 'login_email',
          limit: 5,
          windowMs: 900000,
        }),
      ]),
    );
  });

  it('returns a rate-limit error after a failed credential attempt when the limiter denies it', async () => {
    const { local, state, limiter, hasher } = service();
    seedActiveAccount(state);
    limiter.allowed = false;
    hasher.result = false;

    await expect(
      local.login({ email: EMAIL, password: 'wrong password' }, '203.0.113.7'),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429 });
  });

  it('rotates a valid refresh credential and does not count successful refreshes', async () => {
    const { local, state, limiter } = service();
    seedActiveAccount(state);
    const login = sessionOf(
      await local.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    );

    await expect(
      local.refresh(login.refreshToken, '203.0.113.7'),
    ).resolves.toEqual({
      accessToken: `jwt-for-${USER_ID}`,
      expiresIn: 900,
      refreshToken: 'refresh-2',
    });
    expect(state.refreshTokens.get('hash:refresh-1')).toMatchObject({
      usedAt: NOW,
    });
    expect(limiter.calls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'refresh_ip' }),
        expect.objectContaining({ scope: 'refresh_token' }),
      ]),
    );
  });

  it('revokes the whole family when a rotated token is replayed', async () => {
    const { local, state } = service();
    seedActiveAccount(state);
    const login = sessionOf(
      await local.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    );
    const rotated = await local.refresh(login.refreshToken, '203.0.113.7');

    await expect(
      local.refresh(login.refreshToken, '203.0.113.7'),
    ).rejects.toMatchObject({ code: 'AUTH_REFRESH_TOKEN_INVALID' });
    expect(state.refreshTokens.get('hash:refresh-2')?.revokedAt).toEqual(NOW);
    await expect(
      local.refresh(rotated.refreshToken, '203.0.113.7'),
    ).rejects.toMatchObject({ code: 'AUTH_REFRESH_TOKEN_INVALID' });
  });

  it('logs out idempotently and leaves another login usable', async () => {
    const { local, state } = service();
    seedActiveAccount(state);
    const first = sessionOf(
      await local.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    );
    const second = sessionOf(
      await local.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    );

    await expect(local.logout(first.refreshToken)).resolves.toBeUndefined();
    await expect(local.logout(first.refreshToken)).resolves.toBeUndefined();
    expect(state.refreshTokens.get('hash:refresh-1')?.revokedAt).toEqual(NOW);
    await expect(
      local.refresh(second.refreshToken, '203.0.113.7'),
    ).resolves.toMatchObject({ accessToken: `jwt-for-${USER_ID}` });
  });

  it('uses only the IP failure limit when the cookie is missing', async () => {
    const { local, limiter } = service();

    await expect(local.refresh(undefined, '203.0.113.7')).rejects.toMatchObject(
      {
        code: 'AUTH_REFRESH_TOKEN_INVALID',
      },
    );
    expect(limiter.calls).toEqual([
      expect.objectContaining({
        scope: 'refresh_ip',
        limit: 20,
        windowMs: 300000,
      }),
    ]);
  });

  it('uses the strict expiry boundary and leaves the family available for audit', async () => {
    const { local, state, clock } = service();
    seedActiveAccount(state);
    const login = sessionOf(
      await local.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    );
    clock.value = new Date('2026-10-20T00:00:00.000Z');

    await expect(
      local.refresh(login.refreshToken, '203.0.113.7'),
    ).rejects.toMatchObject({
      code: 'AUTH_REFRESH_TOKEN_INVALID',
    });
    expect(state.refreshTokens.get('hash:refresh-1')).toMatchObject({
      usedAt: undefined,
      revokedAt: undefined,
    });
  });

  it('rejects disabled accounts without consuming a failure limit for infrastructure errors', async () => {
    const { local, state, limiter } = service();
    seedActiveAccount(state);
    const login = sessionOf(
      await local.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    );
    setStatus(state, 'disabled');

    await expect(
      local.refresh(login.refreshToken, '203.0.113.7'),
    ).rejects.toMatchObject({
      code: 'AUTH_REFRESH_TOKEN_INVALID',
    });
    expect(limiter.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'refresh_ip' }),
        expect.objectContaining({ scope: 'refresh_token' }),
      ]),
    );

    const unavailable = service();
    unavailable.refreshSessions.failFindRefreshToken = true;
    await expect(
      unavailable.local.refresh('refresh-unknown', '203.0.113.7'),
    ).rejects.toThrow('durable store unavailable');
    expect(unavailable.limiter.calls).toHaveLength(0);
  });
});
