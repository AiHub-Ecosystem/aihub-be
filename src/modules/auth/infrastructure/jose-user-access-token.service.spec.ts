import {
  type CryptoKey,
  type KeyObject,
  SignJWT,
  decodeJwt,
  decodeProtectedHeader,
  exportPKCS8,
  generateKeyPair,
} from 'jose';

import { JoseUserAccessTokenService } from './jose-user-access-token.service';

async function keyPair() {
  const generated = await generateKeyPair('RS256', { extractable: true });
  return {
    privateKeyPem: await exportPKCS8(generated.privateKey),
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
  };
}

async function signedToken(
  privateKey: CryptoKey | KeyObject,
  overrides: {
    readonly issuer?: string;
    readonly audience?: string;
    readonly issuedAt?: number;
    readonly expiresAt?: number;
    readonly kid?: string;
    readonly extra?: Record<string, unknown>;
  } = {},
) {
  return new SignJWT(overrides.extra ?? {})
    .setProtectedHeader({
      alg: 'RS256',
      kid: overrides.kid ?? 'user-access-2026-09',
    })
    .setIssuer(overrides.issuer ?? 'https://api.test.aihub.example.com')
    .setAudience(overrides.audience ?? 'aihub-user-api')
    .setSubject('usr_01J00000000000000000000000')
    .setJti('jti')
    .setIssuedAt(overrides.issuedAt ?? 1_800_000_000)
    .setExpirationTime(overrides.expiresAt ?? 1_800_000_900)
    .sign(privateKey);
}

function tamperHeader(token: string, header: Record<string, unknown>): string {
  const [, payload, signature] = token.split('.');
  return `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${payload}.${signature}`;
}

function config(privateKeyPem: string) {
  return {
    privateKeyPem,
    keyId: 'user-access-2026-09',
    issuer: 'https://api.test.aihub.example.com',
    audience: 'aihub-user-api',
    expiresInSeconds: 900,
    clockSkewSeconds: 60,
  } as const;
}

describe('JoseUserAccessTokenService', () => {
  it('issues RS256 tokens with only the shared access claims', async () => {
    const keys = await keyPair();
    const service = new JoseUserAccessTokenService(
      config(keys.privateKeyPem),
      () => 1_800_000_000,
    );

    const issued = await service.issue('usr_01J00000000000000000000000');
    const payload = decodeJwt(issued.token);
    const header = decodeProtectedHeader(issued.token);

    expect(issued.expiresIn).toBe(900);
    expect(header).toMatchObject({ alg: 'RS256', kid: 'user-access-2026-09' });
    expect(Object.keys(payload).sort()).toEqual(
      ['aud', 'exp', 'iat', 'iss', 'jti', 'sub'].sort(),
    );
    expect(payload).toMatchObject({
      iss: 'https://api.test.aihub.example.com',
      aud: 'aihub-user-api',
      sub: 'usr_01J00000000000000000000000',
      iat: 1_800_000_000,
      exp: 1_800_000_900,
    });

    await expect(service.verify(issued.token)).resolves.toEqual({
      userId: 'usr_01J00000000000000000000000',
      jti: expect.any(String),
    });
  });

  it('maps malformed, expired, and claim-tampered tokens to one safe error', async () => {
    const keys = await keyPair();
    const service = new JoseUserAccessTokenService(
      config(keys.privateKeyPem),
      () => 1_800_000_000,
    );
    const issued = await service.issue('usr_01J00000000000000000000000');
    const extraClaim = await signedToken(keys.privateKey, {
      extra: { email: 'person@example.com' },
    });

    await expect(service.verify('not-a-jwt')).rejects.toMatchObject({
      code: 'AUTH_USER_ACCESS_TOKEN_INVALID',
      httpStatus: 401,
    });
    await expect(
      service.verify(
        (() => {
          const parts = issued.token.split('.');
          const signature = parts[2] ?? '';
          parts[2] = `${signature.startsWith('x') ? 'y' : 'x'}${signature.slice(1)}`;
          return parts.join('.');
        })(),
      ),
    ).rejects.toMatchObject({
      code: 'AUTH_USER_ACCESS_TOKEN_INVALID',
    });
    await expect(service.verify(extraClaim)).rejects.toMatchObject({
      code: 'AUTH_USER_ACCESS_TOKEN_INVALID',
    });

    const wrongKid = await signedToken(keys.privateKey, { kid: 'old-key' });
    await expect(service.verify(wrongKid)).rejects.toMatchObject({
      code: 'AUTH_USER_ACCESS_TOKEN_INVALID',
    });

    await expect(
      service.verify(
        tamperHeader(issued.token, {
          alg: 'HS256',
          kid: 'user-access-2026-09',
        }),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_USER_ACCESS_TOKEN_INVALID' });
    await expect(
      service.verify(
        await signedToken(keys.privateKey, {
          issuedAt: 1_800_000_061,
          expiresAt: 1_800_000_961,
        }),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_USER_ACCESS_TOKEN_INVALID' });
    await expect(
      service.verify(
        await signedToken(keys.privateKey, {
          issuedAt: 1_800_000_000,
          expiresAt: 1_800_000_901,
        }),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_USER_ACCESS_TOKEN_INVALID' });
    await expect(
      service.verify(
        await signedToken(keys.privateKey, {
          issuer: 'https://other.example.com',
        }),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_USER_ACCESS_TOKEN_INVALID' });
  });

  it('fails closed when key metadata is missing', async () => {
    const keys = await keyPair();

    expect(
      () =>
        new JoseUserAccessTokenService(
          { ...config(keys.privateKeyPem), keyId: '' },
          () => 1_800_000_000,
        ),
    ).toThrow('User Access JWT configuration is invalid');
  });
});
