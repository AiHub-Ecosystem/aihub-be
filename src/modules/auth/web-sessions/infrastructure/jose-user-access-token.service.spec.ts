import { generateKeyPairSync } from 'node:crypto';

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

    const verified = await service.verify(issued.token);
    expect(verified).toMatchObject({
      userId: 'usr_01J00000000000000000000000',
    });
    expect(verified.jti).toEqual(expect.any(String));
  });

  it('maps malformed, expired, and claim-tampered tokens to one safe error', async () => {
    const keys = await keyPair();
    const service = new JoseUserAccessTokenService(
      config(keys.privateKeyPem),
      () => 1_800_000_000,
    );
    const issued = await service.issue('usr_01J00000000000000000000000');

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

  it('accepts a token from the next release that carries an extra claim', async () => {
    const keys = await keyPair();
    const service = new JoseUserAccessTokenService(
      config(keys.privateKeyPem),
      () => 1_800_000_000,
    );
    const nextRelease = await signedToken(keys.privateKey, {
      extra: { tier: 'pro', scopes: ['a', 'b'] },
    });

    await expect(service.verify(nextRelease)).resolves.toEqual({
      userId: 'usr_01J00000000000000000000000',
      jti: 'jti',
    });
  });

  it('still refuses a token that lacks a required claim or shapes one wrongly', async () => {
    const keys = await keyPair();
    const service = new JoseUserAccessTokenService(
      config(keys.privateKeyPem),
      () => 1_800_000_000,
    );
    const base = () =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'user-access-2026-09' })
        .setIssuer('https://api.test.aihub.example.com')
        .setAudience('aihub-user-api')
        .setSubject('usr_01J00000000000000000000000')
        .setIssuedAt(1_800_000_000)
        .setExpirationTime(1_800_000_900);

    const withoutJti = await base().sign(keys.privateKey);
    const oversizedJti = await base()
      .setJti('x'.repeat(257))
      .sign(keys.privateKey);
    const wrongSubject = await base()
      .setSubject('person@example.com')
      .setJti('jti')
      .sign(keys.privateKey);

    for (const token of [withoutJti, oversizedJti, wrongSubject]) {
      await expect(service.verify(token)).rejects.toMatchObject({
        code: 'AUTH_USER_ACCESS_TOKEN_INVALID',
      });
    }
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

  it('refuses an RSA signing key below 2048 bits without echoing its value', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const privateKeyPem = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    let error: unknown;

    try {
      new JoseUserAccessTokenService(config(privateKeyPem));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('AIHUB_USER_ACCESS_JWT_PRIVATE_KEY');
    expect(message).toContain('2048');
    expect(message).not.toContain(privateKeyPem);
  });

  it('keeps malformed and non-RSA key errors distinct from a short RSA key', () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const ecPrivateKeyPem = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();

    expect(() => new JoseUserAccessTokenService(config('not a key'))).toThrow(
      'User Access JWT configuration is invalid',
    );
    expect(
      () => new JoseUserAccessTokenService(config(ecPrivateKeyPem)),
    ).toThrow('User Access JWT configuration is invalid');
  });
});
