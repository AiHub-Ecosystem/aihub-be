import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import { InMemoryAuthMfaAdapter } from '@/modules/auth/testing/in-memory-auth-mfa.adapter';
import {
  createInMemoryAuthState,
  seedAccount,
} from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryUserAccountAdapter } from '@/modules/auth/testing/in-memory-user-account.adapter';
import type { AuthMfaCipherPort } from './auth-mfa-repository.port';
import { AuthMfaService } from './auth-mfa.service';
import type { AuthRateLimiterPort } from './auth-rate-limiter.port';
import type { EmailPayloadCipherPort } from './email-delivery-request.port';
import type { PasswordHasherPort } from './password-hasher.port';

const USER_ID = 'usr_01J00000000000000000000000';
const EMAIL = 'person@example.com';
const NOW = new Date(59_000);
const RFC_TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const FACTOR_ID = 'mfa_01J00000000000000000000000';

class FakeClock {
  now(): Date {
    return new Date(NOW);
  }
}

class FakeCipher implements AuthMfaCipherPort {
  encrypt(plaintext: string) {
    return {
      keyId: 'memory',
      ciphertext: `sealed:${Buffer.from(plaintext).toString('base64url')}`,
    };
  }

  decrypt(_keyId: string, ciphertext: string): string {
    return Buffer.from(
      ciphertext.slice('sealed:'.length),
      'base64url',
    ).toString();
  }
}

class FakeEmailCipher implements EmailPayloadCipherPort {
  encrypt(plaintext: string): string {
    return `sealed:${Buffer.from(plaintext).toString('base64url')}`;
  }

  decrypt(envelope: string): string {
    return Buffer.from(
      envelope.slice('sealed:'.length),
      'base64url',
    ).toString();
  }
}

class FakeHasher implements PasswordHasherPort {
  async hash(password: string): Promise<string> {
    return `hash:${password}`;
  }

  async verify(password: string, passwordHash: string): Promise<boolean> {
    return passwordHash === `hash:${password}`;
  }
}

class FakeLimiter implements AuthRateLimiterPort {
  readonly calls: Parameters<AuthRateLimiterPort['consume']>[0][] = [];

  async consume(input: Parameters<AuthRateLimiterPort['consume']>[0]) {
    this.calls.push(input);
    return { allowed: true };
  }
}

function harness() {
  const state = createInMemoryAuthState();
  seedAccount(state, {
    userId: USER_ID,
    email: EMAIL,
    username: 'person_01',
    passwordHash: 'hash:correct password',
  });
  const limiter = new FakeLimiter();
  const service = new AuthMfaService(
    new InMemoryAuthMfaAdapter(state),
    new FakeCipher(),
    new InMemoryUserAccountAdapter(state),
    new FakeHasher(),
    limiter,
    new FakeEmailCipher(),
    prefixedIdGenerator('edr_'),
    prefixedIdGenerator('mfa_'),
    new FakeClock(),
  );
  return { service, state, limiter };
}

describe('AuthMfaService', () => {
  it('requires a fresh password to begin enrollment and stores only encrypted secret data', async () => {
    const { service, state } = harness();

    await expect(
      service.beginEnrollment({
        userId: USER_ID,
        password: 'wrong password',
        ip: '192.0.2.1',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_CREDENTIALS_INVALID' });
    expect(state.mfaFactors.size).toBe(0);

    const enrollment = await service.beginEnrollment({
      userId: USER_ID,
      password: 'correct password',
      ip: '192.0.2.1',
    });
    expect(enrollment.secret).toMatch(/^[A-Z2-7]{32}$/u);
    expect(enrollment.otpauthUri).toContain(encodeURIComponent(EMAIL));
    expect(state.mfaFactors.get(USER_ID)).toMatchObject({
      status: 'pending',
    });
    expect(state.mfaFactors.get(USER_ID)?.secret).not.toContain(
      enrollment.secret,
    );
    expect(
      new FakeCipher().decrypt('memory', state.mfaFactors.get(USER_ID)!.secret),
    ).toBe(enrollment.secret);
  });

  it('confirms a pending factor, returns one-time recovery codes, and queues an email-only notice', async () => {
    const { service, state, limiter } = harness();
    state.mfaFactors.set(USER_ID, {
      factorId: FACTOR_ID,
      status: 'pending',
      email: EMAIL,
      secret: new FakeCipher().encrypt(RFC_TOTP_SECRET).ciphertext,
    });

    const codes = await service.confirmEnrollment({
      userId: USER_ID,
      code: '287082',
      ip: '192.0.2.1',
    });

    expect(codes).toHaveLength(8);
    expect(state.mfaFactors.get(USER_ID)?.status).toBe('enabled');
    const storedHashes = state.recoveryCodes.get(USER_ID);
    expect(storedHashes?.size).toBe(8);
    expect([...(storedHashes ?? [])]).not.toContain(codes[0]);
    const request = state.emailDeliveryRequests[0];
    expect(request?.kind).toBe('mfa_enabled_notification');
    expect(
      JSON.parse(new FakeEmailCipher().decrypt(request!.payloadCiphertext)),
    ).toEqual({ email: EMAIL });
    expect(limiter.calls).toHaveLength(0);
  });

  it('rejects wrong confirmation codes generically and applies the login failure limits', async () => {
    const { service, state, limiter } = harness();
    state.mfaFactors.set(USER_ID, {
      factorId: FACTOR_ID,
      status: 'pending',
      email: EMAIL,
      secret: new FakeCipher().encrypt(RFC_TOTP_SECRET).ciphertext,
    });

    await expect(
      service.confirmEnrollment({
        userId: USER_ID,
        code: '000000',
        ip: '192.0.2.1',
      }),
    ).rejects.toMatchObject({
      code: 'AUTH_CREDENTIALS_INVALID',
      httpStatus: 401,
    });
    expect(limiter.calls.map(({ scope }) => scope)).toEqual([
      'login_ip',
      'login_email',
    ]);
    expect(state.mfaFactors.get(USER_ID)?.status).toBe('pending');
  });

  it('requires and verifies the enabled factor at login', async () => {
    const { service, state } = harness();
    state.mfaFactors.set(USER_ID, {
      factorId: FACTOR_ID,
      status: 'enabled',
      email: EMAIL,
      secret: new FakeCipher().encrypt(RFC_TOTP_SECRET).ciphertext,
    });

    await expect(service.loginProof(USER_ID, undefined)).resolves.toEqual({
      kind: 'required',
    });
    await expect(service.loginProof(USER_ID, '287082')).resolves.toEqual({
      kind: 'proved',
      proof: { kind: 'totp', factorId: FACTOR_ID },
    });
  });

  it('removes the factor only after fresh proof, revokes durable sessions, and queues a notice', async () => {
    const { service, state } = harness();
    state.mfaFactors.set(USER_ID, {
      factorId: FACTOR_ID,
      status: 'enabled',
      email: EMAIL,
      secret: new FakeCipher().encrypt(RFC_TOTP_SECRET).ciphertext,
    });
    state.recoveryCodes.set(USER_ID, new Set(['a'.repeat(64)]));
    state.refreshTokens.set('refresh-hash', {
      tokenId: 'rft_01',
      familyId: 'rfs_01',
      userId: USER_ID,
      expiresAt: new Date(NOW.getTime() + 60_000),
      usedAt: undefined,
      revokedAt: undefined,
    });
    state.webSessions.set('web-hash', {
      sessionId: 'wbs_01',
      userId: USER_ID,
      tokenHash: 'web-hash',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
      lastRenewedAt: NOW,
      revokedAt: undefined,
    });

    await service.removeFactor({
      userId: USER_ID,
      proof: { password: 'correct password' },
      ip: '192.0.2.1',
    });

    expect(state.mfaFactors.has(USER_ID)).toBe(false);
    expect(state.recoveryCodes.has(USER_ID)).toBe(false);
    expect(state.refreshTokens.get('refresh-hash')?.revokedAt).toEqual(NOW);
    expect(state.webSessions.get('web-hash')?.revokedAt).toEqual(NOW);
    expect(state.emailDeliveryRequests[0]?.kind).toBe(
      'mfa_removed_notification',
    );
  });
});
