import { type KeyObject, generateKeyPairSync, randomUUID } from 'node:crypto';

import { SignJWT } from 'jose';

import type { RequestLogStream } from '@/common/observability/request-logger';
import { seedAccount } from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryUserAccessTokenRevocationAdapter } from '@/modules/auth/testing/in-memory-user-access-token-revocation.adapter';
import {
  type LocalAuthTestContext,
  USER_ID,
  createLocalAuthTestContext,
} from '@/modules/auth/testing/local-auth.controller.spec-support';
import { BloomFilterUserAccessTokenRevocationAdapter } from '@/modules/auth/user-access-tokens/infrastructure/bloom-filter/bloom-filter-user-access-token-revocation.adapter';
import { JoseUserAccessTokenService } from '@/modules/auth/web-sessions/infrastructure/jose-user-access-token.service';
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const ISSUER = 'https://api.test.aihub.example.com';
const AUDIENCE = 'aihub-user-api';
const KEY_ID = 'user-access-test';
const OTHER_USER_ID = 'usr_01J00000000000000000000001';

class CapturedLog implements RequestLogStream {
  private readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }

  reset(): void {
    this.lines.length = 0;
  }

  text(): string {
    return this.lines.join('');
  }
}

async function signedToken(
  privateKey: KeyObject,
  userId: string,
  overrides: {
    readonly issuer?: string;
    readonly audience?: string;
    readonly issuedAt?: number;
    readonly expiresAt?: number;
  } = {},
): Promise<string> {
  const issuedAt = overrides.issuedAt ?? Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject(userId)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(overrides.expiresAt ?? issuedAt + 900)
    .sign(privateKey);
}

function invalidSignature(token: string): string {
  const [header, payload, signature] = token.split('.');
  if (
    header === undefined ||
    payload === undefined ||
    signature === undefined
  ) {
    throw new Error('Expected a compact JWT');
  }
  const first = signature.startsWith('A') ? 'B' : 'A';
  return `${header}.${payload}.${first}${signature.slice(1)}`;
}

describe('User Access JWT revocation HTTP boundary', () => {
  let context: LocalAuthTestContext;
  let verifier: JoseUserAccessTokenService;
  let privateKey: KeyObject;
  let revocationStore: InMemoryUserAccessTokenRevocationAdapter;
  let productionRevocationAdapter: BloomFilterUserAccessTokenRevocationAdapter;
  const requestLogs = new CapturedLog();

  beforeAll(async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = keys.privateKey;
    verifier = new JoseUserAccessTokenService({
      privateKeyPem: keys.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      keyId: KEY_ID,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresInSeconds: 900,
      clockSkewSeconds: 60,
    });
    revocationStore = new InMemoryUserAccessTokenRevocationAdapter();
    productionRevocationAdapter =
      new BloomFilterUserAccessTokenRevocationAdapter({
        underlying: revocationStore,
      });
    context = await createLocalAuthTestContext(
      verifier,
      requestLogs,
      registerRequestCompletionLog,
      undefined,
      productionRevocationAdapter,
    );
  });

  afterAll(async () => {
    await context.app.close();
    await productionRevocationAdapter.close();
  });

  beforeEach(() => {
    context.reset();
    revocationStore.reset();
    requestLogs.reset();
    seedAccount(context.state, {
      userId: USER_ID,
      email: 'person@example.com',
      username: 'person_01',
      passwordHash: '$argon2id$fake',
    });
  });

  async function accessToken(userId = USER_ID): Promise<string> {
    return (await verifier.issue(userId)).token;
  }

  async function revoke(
    caller: string,
    target: string,
  ): Promise<Awaited<ReturnType<LocalAuthTestContext['app']['inject']>>> {
    return context.app.inject({
      method: 'POST',
      url: '/v1/auth/user-access-tokens/revoke',
      headers: { authorization: `Bearer ${caller}` },
      payload: { token: target },
    });
  }

  async function me(token: string) {
    return context.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('rejects a committed JWT missed by the production filter and keeps its sibling usable', async () => {
    const target = await accessToken();
    const sibling = await accessToken();
    const claims = await verifier.verify(target);

    // Simulate another instance committing the row without delivering Pub/Sub.
    await revocationStore.revoke({
      issuer: claims.issuer,
      jti: claims.jti,
      effectiveExpiresAt: claims.validUntil,
    });

    expect((await me(target)).statusCode).toBe(401);
    expect((await me(sibling)).statusCode).toBe(200);
  });

  it('rejects only the target, allows an unaffected sibling, and replays with 204', async () => {
    const target = await accessToken();
    const sibling = await accessToken();

    const revoked = await revoke(sibling, target);
    expect(revoked.statusCode).toBe(204);
    expect(revoked.payload).toBe('');
    expect(revoked.headers['cache-control']).toBe('no-store');
    expect((await me(target)).json()).toMatchObject({
      error: { code: 'AUTH_USER_ACCESS_TOKEN_INVALID' },
    });
    expect((await me(sibling)).statusCode).toBe(200);
    expect((await revoke(sibling, target)).statusCode).toBe(204);

    const claims = await verifier.verify(target);
    const records = [...revocationStore.records.values()];
    expect(records).toEqual([
      {
        issuer: claims.issuer,
        jti: claims.jti,
        effectiveExpiresAt: claims.validUntil,
      },
    ]);
    expect(JSON.stringify(records)).not.toContain(target);
    expect(requestLogs.text()).toContain('"event":"request_completed"');
    expect(requestLogs.text()).not.toContain(target);
  });

  it('allows revoking the current Bearer JWT once, then rejects that JWT normally', async () => {
    const target = await accessToken();

    expect((await revoke(target, target)).statusCode).toBe(204);
    expect((await me(target)).json()).toMatchObject({
      error: { code: 'AUTH_USER_ACCESS_TOKEN_INVALID' },
    });
    expect((await revoke(target, target)).statusCode).toBe(401);
  });

  it('uses one generic 401 and writes nothing for invalid tokens or another account', async () => {
    seedAccount(context.state, {
      userId: OTHER_USER_ID,
      email: 'other@example.com',
      username: 'other_01',
      passwordHash: '$argon2id$fake',
    });
    const caller = await accessToken();
    const valid = await accessToken();
    const now = Math.floor(Date.now() / 1000);
    const beyondSkew = await signedToken(privateKey, USER_ID, {
      issuedAt: now - 961,
      expiresAt: now - 61,
    });
    const invalid = [
      await accessToken(OTHER_USER_ID),
      invalidSignature(valid),
      await signedToken(privateKey, USER_ID, {
        issuer: 'https://other.test.example.com',
      }),
      await signedToken(privateKey, USER_ID, { audience: 'other-api' }),
      beyondSkew,
      'not-a-compact-jwt',
    ];

    for (const target of invalid) {
      const response = await revoke(caller, target);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_USER_ACCESS_TOKEN_INVALID' },
      });
    }
    expect(revocationStore.records.size).toBe(0);
  });

  it('keeps a revocation active through the verifier skew boundary', async () => {
    const target = await accessToken();
    const sibling = await accessToken();
    const claims = await verifier.verify(target);
    await revoke(sibling, target);

    expect((await me(target)).statusCode).toBe(401);

    const beforeBoundary = new Date(claims.validUntil.getTime() - 1);
    await expect(
      revocationStore.isRevoked({
        issuer: claims.issuer,
        jti: claims.jti,
        now: beforeBoundary,
      }),
    ).resolves.toBe(true);
    await expect(
      revocationStore.isRevoked({
        issuer: claims.issuer,
        jti: claims.jti,
        now: claims.validUntil,
      }),
    ).resolves.toBe(true);
    await expect(
      revocationStore.isRevoked({
        issuer: claims.issuer,
        jti: claims.jti,
        now: new Date(claims.validUntil.getTime() + 1),
      }),
    ).resolves.toBe(false);
  });

  it('returns a retryable 503 and fails closed when revocation storage fails', async () => {
    const caller = await accessToken();
    const target = await accessToken();

    revocationStore.failLookup = true;
    const protectedRequest = await me(caller);
    expect(protectedRequest.statusCode).toBe(503);
    expect(protectedRequest.json()).toMatchObject({
      error: { code: 'DATABASE_UNAVAILABLE', retryable: true },
    });

    revocationStore.failLookup = false;
    revocationStore.failRevoke = true;
    const revokeRequest = await revoke(caller, target);
    expect(revokeRequest.statusCode).toBe(503);
    expect(revokeRequest.json()).toMatchObject({
      error: { code: 'DATABASE_UNAVAILABLE', retryable: true },
    });
    expect(revocationStore.records.size).toBe(0);
  });

  it('validates the request shape before writing', async () => {
    const caller = await accessToken();
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/user-access-tokens/revoke',
      headers: { authorization: `Bearer ${caller}` },
      payload: { token: '', extra: true },
    });

    expect(response.statusCode).toBe(400);
    expect(revocationStore.records.size).toBe(0);
  });
});
