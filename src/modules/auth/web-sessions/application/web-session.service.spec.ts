import type { IdMinter } from '@/common/ids/prefixed-id';
import type { PasswordHasherPort } from '@/modules/auth/local-credentials/application/password-hasher.port';
import type { AuthMfaServicePort } from '@/modules/auth/mfa/application/auth-mfa-repository.port';
import type { AuthRateLimiterPort } from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';
import {
  createInMemoryAuthState,
  seedAccount,
} from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryUserAccountAdapter } from '@/modules/auth/testing/in-memory-user-account.adapter';
import { InMemoryVerificationTokenAdapter } from '@/modules/auth/testing/in-memory-verification-token.adapter';
import { InMemoryWebSessionAdapter } from '@/modules/auth/testing/in-memory-web-session.adapter';
import type { VerificationTokenPort } from '@/modules/auth/verification/application/verification-token.port';
import type { UserAccessTokenIssuerPort } from './user-access-token.port';
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
  async issue() {
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
    new UserAccessTokenIssuerFake(),
    new LoginMfaFake(mfaResult),
  );

  return {
    service,
    state,
    passwordHasher,
    createWebSession,
    updatePasswordHash,
  };
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
