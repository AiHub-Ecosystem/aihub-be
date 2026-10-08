import {
  type JWK,
  SignJWT,
  compactVerify,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  importJWK,
} from 'jose';

import type { PublicJsonWebKey } from '@/modules/identity/domain/organization-identity-config';
import type { OrganizationIdentityConfig } from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import type { JwksKeyProviderPort } from './jwks-key-provider.port';
import type {
  UserAssertionCryptoPort,
  UserAssertionProtectedHeader,
} from './user-assertion-crypto.port';
import { UserAssertionVerifier } from './user-assertion-verifier';
import type { ResolvedUserIdentity } from './user-identity-resolver.port';

const NOW = 1_700_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toJwk(key: PublicJsonWebKey): JWK {
  if (
    key.kty === 'RSA' &&
    typeof key.n === 'string' &&
    typeof key.e === 'string'
  ) {
    return { kty: 'RSA', n: key.n, e: key.e };
  }

  throw new Error('test key is invalid');
}

class TestUserAssertionCrypto implements UserAssertionCryptoPort {
  decodeHeader(signedAssertion: string): UserAssertionProtectedHeader {
    const header = decodeProtectedHeader(signedAssertion);
    return { alg: header.alg, kid: header.kid };
  }

  async verify(input: {
    readonly signedAssertion: string;
    readonly key: PublicJsonWebKey;
    readonly algorithm: 'RS256' | 'ES256';
  }): Promise<Readonly<Record<string, unknown>>> {
    const result = await compactVerify(
      input.signedAssertion,
      await importJWK(toJwk(input.key), input.algorithm),
      { algorithms: [input.algorithm] },
    );
    const payload: unknown = JSON.parse(
      Buffer.from(result.payload).toString('utf8'),
    );
    if (!isRecord(payload)) {
      throw new Error('test payload is invalid');
    }
    return payload;
  }
}

const config: OrganizationIdentityConfig = {
  organizationId: 'org_acme',
  issuer: 'https://acme.edu',
  jwksUrl: null,
  publicKeysJwks: null,
  allowedAlgorithms: ['RS256'] as const,
  maxAssertionTtlSeconds: 300,
  status: 'active' as const,
};

class FakeKeyProvider implements JwksKeyProviderPort {
  readonly calls: boolean[] = [];

  constructor(
    private readonly initial: { keys: readonly Record<string, unknown>[] },
    private readonly refreshed = this.initial,
  ) {}

  resolve(input: { forceRefresh?: boolean }) {
    this.calls.push(input.forceRefresh === true);
    return Promise.resolve(input.forceRefresh ? this.refreshed : this.initial);
  }

  validateRemote(_input: {
    readonly organizationId: string;
    readonly url: string;
  }): Promise<void> {
    return Promise.resolve();
  }
}

async function rsaFixture(kid = 'rsa-1') {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  return {
    privateKey,
    jwks: { keys: [{ ...jwk, alg: 'RS256', kid }] },
  };
}

async function token(
  privateKey: unknown,
  options: {
    readonly kid?: string;
    readonly issuer?: string;
    readonly audience?: string | string[];
    readonly subject?: string;
    readonly issuedAt?: number;
    readonly expiration?: number;
    readonly jti?: string;
  } = {},
): Promise<string> {
  const header = {
    alg: 'RS256' as const,
    ...(options.kid === undefined ? {} : { kid: options.kid }),
  };
  const builder = new SignJWT({})
    .setProtectedHeader(header)
    .setIssuer(options.issuer ?? config.issuer)
    .setAudience(options.audience ?? 'aihub')
    .setSubject(options.subject ?? 'user_123')
    .setIssuedAt(options.issuedAt ?? NOW - 10)
    .setExpirationTime(options.expiration ?? NOW + 100);

  if (options.jti !== undefined) {
    builder.setJti(options.jti);
  }

  return builder.sign(privateKey as never);
}

function verifier(
  provider: JwksKeyProviderPort,
  activeConfig: OrganizationIdentityConfig = {
    ...config,
    publicKeysJwks: null,
  },
) {
  const subject = new UserAssertionVerifier(
    provider,
    new TestUserAssertionCrypto(),
    () => NOW,
  );
  return {
    verify: (input: {
      readonly signedAssertion: string;
      readonly organizationId: string;
    }) => subject.verify({ ...input, config: activeConfig }),
  };
}

describe('UserAssertionVerifier', () => {
  it('verifies a signed assertion and binds the result to the API-key organization', async () => {
    const fixture = await rsaFixture();
    const provider = new FakeKeyProvider(fixture.jwks);
    const assertion = await token(fixture.privateKey, { jti: 'jti-1' });

    await expect(
      verifier(provider).verify({
        signedAssertion: assertion,
        organizationId: 'org_acme',
      }),
    ).resolves.toEqual<ResolvedUserIdentity>({
      userId: 'user_123',
      organizationId: 'org_acme',
      scopes: [],
    });
  });

  it.each([
    ['missing jti', {}],
    ['expired', { expiration: NOW - 61, jti: 'jti-1' }],
    ['future iat', { issuedAt: NOW + 60, jti: 'jti-1' }],
    ['exceeds configured ttl', { expiration: NOW + 400, jti: 'jti-1' }],
    ['wrong issuer', { issuer: 'https://other.example', jti: 'jti-1' }],
    ['wrong audience', { audience: 'other', jti: 'jti-1' }],
    ['audience array', { audience: ['aihub', 'other'], jti: 'jti-1' }],
  ])('rejects %s', async (_name, options) => {
    const fixture = await rsaFixture();
    const assertion = await token(fixture.privateKey, options);

    await expect(
      verifier(new FakeKeyProvider(fixture.jwks)).verify({
        signedAssertion: assertion,
        organizationId: 'org_acme',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_USER_IDENTITY',
      httpStatus: 401,
    });
  });

  it('requires a jti and exact claim string shapes after signature verification', async () => {
    const fixture = await rsaFixture();
    const assertion = await token(fixture.privateKey, { jti: 'x'.repeat(257) });

    await expect(
      verifier(new FakeKeyProvider(fixture.jwks)).verify({
        signedAssertion: assertion,
        organizationId: 'org_acme',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
  });

  it('rejects a tampered signature and unsecured algorithm before trusting claims', async () => {
    const fixture = await rsaFixture();
    const assertion = await token(fixture.privateKey, { jti: 'jti-1' });
    const parts = assertion.split('.');
    const signature = parts[2] ?? '';
    const tamperedSignature = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSignature}`;

    await expect(
      verifier(new FakeKeyProvider(fixture.jwks)).verify({
        signedAssertion: tampered,
        organizationId: 'org_acme',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });

    await expect(
      verifier(new FakeKeyProvider(fixture.jwks)).verify({
        signedAssertion: 'eyJhbGciOiJub25lIn0.e30.',
        organizationId: 'org_acme',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
  });

  it('allows a key without kid only when one usable key matches', async () => {
    const fixture = await rsaFixture();
    const assertion = await token(fixture.privateKey, { jti: 'jti-1' });

    await expect(
      verifier(new FakeKeyProvider(fixture.jwks)).verify({
        signedAssertion: assertion,
        organizationId: 'org_acme',
      }),
    ).resolves.toMatchObject({ userId: 'user_123' });
  });

  it('refreshes once for an unknown kid and then verifies the rotated key', async () => {
    const oldFixture = await rsaFixture('old');
    const newFixture = await rsaFixture('new');
    const assertion = await token(newFixture.privateKey, {
      kid: 'new',
      jti: 'jti-rotation',
    });
    const provider = new FakeKeyProvider(oldFixture.jwks, newFixture.jwks);

    await expect(
      verifier(provider).verify({
        signedAssertion: assertion,
        organizationId: 'org_acme',
      }),
    ).resolves.toMatchObject({ userId: 'user_123' });
    expect(provider.calls).toEqual([false, true]);
  });

  it('rejects multiple matching keys when kid is absent', async () => {
    const first = await rsaFixture('one');
    const second = await rsaFixture('two');
    const assertion = await token(first.privateKey, { jti: 'jti-1' });
    const provider = new FakeKeyProvider({
      keys: [...first.jwks.keys, ...second.jwks.keys],
    });

    await expect(
      verifier(provider).verify({
        signedAssertion: assertion,
        organizationId: 'org_acme',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
  });

  it('does not accept an algorithm outside the organization allowlist', async () => {
    const fixture = await rsaFixture();
    const assertion = await token(fixture.privateKey, { jti: 'jti-1' });
    const provider = new FakeKeyProvider(fixture.jwks);
    const esOnly: OrganizationIdentityConfig = {
      ...config,
      allowedAlgorithms: ['ES256'],
      publicKeysJwks: null,
    };

    await expect(
      verifier(provider, esOnly).verify({
        signedAssertion: assertion,
        organizationId: 'org_acme',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
    expect(provider.calls).toEqual([]);
  });

  it.each([
    ['an internal space', 'user 123'],
    ['a non-ASCII character', 'học_viên_1'],
    ['257 characters', 'x'.repeat(257)],
  ])(
    'rejects a sub with %s under the End-User ID rule',
    async (_name, subject) => {
      const fixture = await rsaFixture();
      const assertion = await token(fixture.privateKey, {
        subject,
        jti: 'jti-1',
      });

      await expect(
        verifier(new FakeKeyProvider(fixture.jwks)).verify({
          signedAssertion: assertion,
          organizationId: 'org_acme',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_USER_IDENTITY',
        httpStatus: 401,
      });
    },
  );
});
