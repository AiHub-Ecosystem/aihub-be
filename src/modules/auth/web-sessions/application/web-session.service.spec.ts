import type { IdMinter } from '@/common/ids/prefixed-id';
import type { PasswordHasherPort } from '@/modules/auth/local-credentials/application/password-hasher.port';
import type { AuthMfaServicePort } from '@/modules/auth/mfa/application/auth-mfa-repository.port';
import type { AuthRateLimiterPort } from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';
import type {
  AuthSecurityEvent,
  AuthSecurityEventRecorderPort,
} from '@/modules/auth/shared/application/auth-security-event.port';
import {
  createInMemoryAuthState,
  seedAccount,
} from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryUserAccountAdapter } from '@/modules/auth/testing/in-memory-user-account.adapter';
import { InMemoryVerificationTokenAdapter } from '@/modules/auth/testing/in-memory-verification-token.adapter';
import { InMemoryWebSessionAdapter } from '@/modules/auth/testing/in-memory-web-session.adapter';
import type { VerificationTokenPort } from '@/modules/auth/verification/application/verification-token.port';
import type {
  UserAccessSession,
  UserAccessTokenIssuerPort,
} from './user-access-token.port';
import type { WebSessionTokenIssuerPort } from './web-session-token.port';
import { WebSessionService } from './web-session.service';

const USER_ID = 'usr_01J00000000000000000000000';
const EMAIL = 'person@example.com';
const PASSWORD = 'correct horse battery';
const OLD_HASH = '$argon2id$v=19$m=8192,p=1,t=1$c2FsdA$aGFzaA';
const NEW_HASH = 'argon2:current:correct horse battery';
const NOW = new Date('2026-10-08T00:00:00.000Z');

class PasswordHasherFake implements PasswordHasherPort {
  async hash(): Promise<string> {
    return NEW_HASH;
  }

  needsRehash(hash: string): boolean {
    return hash === OLD_HASH;
  }

  async verify(): Promise<boolean> {
    return true;
  }
}

class LoginRateLimiterFake implements AuthRateLimiterPort {
  async check() {
    return { allowed: true };
  }

  async consume() {
    return { allowed: true };
  }
}

class LoginMfaFake implements AuthMfaServicePort {
  constructor(
    private readonly result: Awaited<
      ReturnType<AuthMfaServicePort['loginProof']>
    >,
  ) {}

  async loginProof() {
    return this.result;
  }

  async beginEnrollment() {
    return { secret: 'secret', otpauthUri: 'otpauth://totp/AIHUB:test' };
  }

  async confirmEnrollment() {
    return [];
  }

  async removeFactor(): Promise<void> {}
}

class WebSessionTokenFake implements WebSessionTokenIssuerPort {
  issue(now: Date) {
    return {
      raw: 'web-session-token',
      hash: 'web-session-token-hash',
      expiresAt: new Date(now.getTime() + 86_400_000),
    };
  }

  hash(raw: string): string {
    return `hash:${raw}`;
  }
}

class VerificationTokenFake implements VerificationTokenPort {
  issue(now: Date) {
    return {
      id: 'evt_01J00000000000000000000000',
      raw: 'verification-token',
      hash: this.hash('verification-token'),
      expiresAt: new Date(now.getTime() + 86_400_000),
    };
  }

  hash(raw: string): string {
    return `hash:${raw}`;
  }
}

class UserAccessTokenIssuerFake implements UserAccessTokenIssuerPort {
  lastSession: UserAccessSession | undefined;
  afterIssue: (() => void) | undefined;

  async issue(_userId: string, session?: UserAccessSession) {
    this.lastSession = session;
    this.afterIssue?.();
    return { token: 'user-access-token', expiresIn: 900 };
  }
}

function harness(
  mfaResult: Awaited<ReturnType<AuthMfaServicePort['loginProof']>> = {
    kind: 'none',
  },
) {
  const state = createInMemoryAuthState();
  seedAccount(state, { userId: USER_ID, email: EMAIL, passwordHash: OLD_HASH });
  const userAccounts = new InMemoryUserAccountAdapter(state);
  const webSessions = new InMemoryWebSessionAdapter(state);
  const updatePasswordHash = jest.spyOn(userAccounts, 'updatePasswordHash');
  const createWebSession = jest.spyOn(webSessions, 'createWebSession');
  const passwordHasher = new PasswordHasherFake();
  const accessTokens = new UserAccessTokenIssuerFake();
  const securityEvents: AuthSecurityEvent[] = [];
  const securityEventRecorder: AuthSecurityEventRecorderPort = {
    record(event) {
      securityEvents.push(event);
    },
  };
  const service = new WebSessionService(
    webSessions,
    new WebSessionTokenFake(),
    (() => 'wss_01J00000000000000000000000') satisfies IdMinter,
    userAccounts,
    passwordHasher,
    new LoginRateLimiterFake(),
    { now: () => NOW },
    new InMemoryVerificationTokenAdapter(state),
    new VerificationTokenFake(),
    accessTokens,
    new LoginMfaFake(mfaResult),
    securityEventRecorder,
  );

  return {
    service,
    state,
    passwordHasher,
    accessTokens,
    createWebSession,
    updatePasswordHash,
    securityEvents,
  };
}

const EXCHANGE_TOKEN = 'web-session-token';
const EXCHANGE_TOKEN_HASH = `hash:${EXCHANGE_TOKEN}`;
const EXCHANGE_SESSION_ID = 'wss_01J00000000000000000000000';

function seedExchangeSession(
  test: ReturnType<typeof harness>,
  options: { readonly expiresAt?: Date; readonly revokedAt?: Date } = {},
): void {
  test.state.webSessions.set(EXCHANGE_TOKEN_HASH, {
    sessionId: EXCHANGE_SESSION_ID,
    userId: USER_ID,
    tokenHash: EXCHANGE_TOKEN_HASH,
    createdAt: NOW,
    expiresAt: options.expiresAt ?? new Date(NOW.getTime() + 86_400_000),
    lastRenewedAt: NOW,
    revokedAt: options.revokedAt,
  });
}

describe('WebSessionService.createWebSession password hash upgrade', () => {
  it('upgrades a legacy hash after MFA and uses the new hash to create the session', async () => {
    const test = harness();

    await expect(
      test.service.createWebSession(
        { email: EMAIL, password: PASSWORD },
        '203.0.113.7',
      ),
    ).resolves.toMatchObject({ kind: 'created' });

    expect(test.updatePasswordHash).toHaveBeenCalledWith({
      userId: USER_ID,
      expectedPasswordHash: OLD_HASH,
      passwordHash: NEW_HASH,
      now: NOW,
    });
    expect(test.createWebSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        expectedPasswordHash: NEW_HASH,
      }),
    );
    expect(test.state.accounts.get(USER_ID)?.passwordHash).toBe(NEW_HASH);
  });

  it('does not upgrade or create a session when the password is incorrect', async () => {
    const test = harness();
    jest.spyOn(test.passwordHasher, 'verify').mockResolvedValue(false);

    await expect(
      test.service.createWebSession(
        { email: EMAIL, password: PASSWORD },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({ code: 'AUTH_CREDENTIALS_INVALID' });

    expect(test.securityEvents).toEqual([
      {
        event: 'login_failed',
        userAccountId: USER_ID,
        occurredAt: NOW,
      },
    ]);

    expect(test.updatePasswordHash).not.toHaveBeenCalled();
    expect(test.createWebSession).not.toHaveBeenCalled();
    expect(test.state.accounts.get(USER_ID)?.passwordHash).toBe(OLD_HASH);
  });

  it('does not upgrade or create a session while MFA is required', async () => {
    const test = harness({ kind: 'required' });

    await expect(
      test.service.createWebSession(
        { email: EMAIL, password: PASSWORD },
        '203.0.113.7',
      ),
    ).resolves.toEqual({ kind: 'mfa-required' });

    expect(test.updatePasswordHash).not.toHaveBeenCalled();
    expect(test.createWebSession).not.toHaveBeenCalled();
    expect(test.state.accounts.get(USER_ID)?.passwordHash).toBe(OLD_HASH);
  });

  it('fails closed when persisting the upgraded hash fails', async () => {
    const test = harness();
    test.updatePasswordHash.mockRejectedValue(new Error('storage unavailable'));

    await expect(
      test.service.createWebSession(
        { email: EMAIL, password: PASSWORD },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({ code: 'AUTH_WEB_SESSION_UNAVAILABLE' });

    expect(test.createWebSession).not.toHaveBeenCalled();
    expect(test.state.accounts.get(USER_ID)?.passwordHash).toBe(OLD_HASH);
  });
});

describe('WebSessionService access token session identity', () => {
  it('issues a Web Session access token carrying the durable session id', async () => {
    const test = harness();
    const sessionId = 'wss_01J00000000000000000000000';
    test.state.webSessions.set('hash:web-session-token', {
      sessionId,
      userId: USER_ID,
      tokenHash: 'hash:web-session-token',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 86_400_000),
      lastRenewedAt: NOW,
      revokedAt: undefined,
    });

    await expect(
      test.service.exchangeWebSession(
        { token: 'web-session-token' },
        '203.0.113.7',
      ),
    ).resolves.toMatchObject({ token: 'user-access-token' });

    expect(test.accessTokens.lastSession).toEqual({
      kind: 'web',
      id: sessionId,
    });
    expect(test.securityEvents).toEqual([]);
  });
});

describe('WebSessionService exchange refusal events', () => {
  it.each([
    ['missing', undefined],
    ['unknown', 'unknown-web-session-token'],
  ] as const)(
    'records one unknown-session event for a %s token',
    async (_kind, token) => {
      const test = harness();

      await expect(
        test.service.exchangeWebSession({ token }, undefined),
      ).rejects.toMatchObject({ code: 'AUTH_WEB_SESSION_INVALID' });

      expect(test.securityEvents).toEqual([
        { event: 'web_session_exchange_refused_unknown', occurredAt: NOW },
      ]);
      expect(JSON.stringify(test.securityEvents)).not.toContain(
        token ?? EXCHANGE_TOKEN,
      );
    },
  );

  it('records an expired-session refusal with the known account ID', async () => {
    const test = harness();
    seedExchangeSession(test, { expiresAt: new Date(NOW.getTime() - 1) });

    await expect(
      test.service.exchangeWebSession({ token: EXCHANGE_TOKEN }, undefined),
    ).rejects.toMatchObject({ code: 'AUTH_WEB_SESSION_INVALID' });

    expect(test.securityEvents).toEqual([
      {
        event: 'web_session_exchange_refused_expired',
        userAccountId: USER_ID,
        occurredAt: NOW,
      },
    ]);
    expect(JSON.stringify(test.securityEvents)).not.toContain(EXCHANGE_TOKEN);
  });

  it('records a revoked-session refusal with the known account ID', async () => {
    const test = harness();
    seedExchangeSession(test, { revokedAt: NOW });

    await expect(
      test.service.exchangeWebSession({ token: EXCHANGE_TOKEN }, undefined),
    ).rejects.toMatchObject({ code: 'AUTH_WEB_SESSION_INVALID' });

    expect(test.securityEvents).toEqual([
      {
        event: 'web_session_exchange_refused_revoked',
        userAccountId: USER_ID,
        occurredAt: NOW,
      },
    ]);
  });

  it('records an inactive-account refusal with the known account ID', async () => {
    const test = harness();
    seedExchangeSession(test);
    const account = test.state.accounts.get(USER_ID);
    if (account === undefined) {
      throw new Error('expected the seeded account');
    }
    account.status = 'disabled';

    await expect(
      test.service.exchangeWebSession({ token: EXCHANGE_TOKEN }, undefined),
    ).rejects.toMatchObject({ code: 'AUTH_WEB_SESSION_INVALID' });

    expect(test.securityEvents).toEqual([
      {
        event: 'web_session_exchange_refused_inactive_account',
        userAccountId: USER_ID,
        occurredAt: NOW,
      },
    ]);
  });

  it('records a concurrent revocation after signing as one refusal', async () => {
    const test = harness();
    seedExchangeSession(test);
    test.accessTokens.afterIssue = () => {
      const session = test.state.webSessions.get(EXCHANGE_TOKEN_HASH);
      if (session === undefined) {
        throw new Error('expected the seeded Web Session');
      }
      session.revokedAt = NOW;
    };

    await expect(
      test.service.exchangeWebSession({ token: EXCHANGE_TOKEN }, undefined),
    ).rejects.toMatchObject({ code: 'AUTH_WEB_SESSION_INVALID' });

    expect(test.securityEvents).toEqual([
      {
        event: 'web_session_exchange_refused_revoked',
        userAccountId: USER_ID,
        occurredAt: NOW,
      },
    ]);
  });
});

describe('WebSessionService logout revocation events', () => {
  it('records the account and number of sessions revoked by logout', async () => {
    const test = harness();
    seedExchangeSession(test);

    await expect(
      test.service.revokeWebSession({ token: EXCHANGE_TOKEN }),
    ).resolves.toBeUndefined();

    expect(test.securityEvents).toEqual([
      {
        event: 'web_session_revoked',
        userAccountId: USER_ID,
        trigger: 'logout',
        sessionsRevoked: 1,
        occurredAt: NOW,
      },
    ]);
  });

  it('does not record a revocation event for an unknown token', async () => {
    const test = harness();

    await test.service.revokeWebSession({ token: 'unknown-web-session-token' });

    expect(test.securityEvents).toEqual([]);
  });
});
