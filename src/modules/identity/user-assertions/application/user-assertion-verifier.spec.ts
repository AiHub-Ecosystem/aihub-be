import {
  type JWK,
  SignJWT,
  compactVerify,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  importJWK,
} from 'jose';

import { AppError } from '@/common/errors/app-error';
import { isRecord } from '@/common/is-record';
import { getMetrics } from '@/common/observability/metrics/metrics';
import type {
  PublicJsonWebKey,
  PublicJsonWebKeySet,
} from '@/modules/identity/domain/organization-identity-config';
import type { OrganizationIdentityConfig } from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import type { JwksKeyProviderPort } from './jwks-key-provider.port';
import type {
  UserAssertionCryptoPort,
  UserAssertionProtectedHeader,
} from './user-assertion-crypto.port';
import type { UserAssertionReplayMarkerPort } from './user-assertion-replay-marker.port';
import { UserAssertionVerifier } from './user-assertion-verifier';
import { identityProviderUnavailable } from './user-identity-errors';
import type { ResolvedUserIdentity } from './user-identity-resolver.port';

const NOW = 1_700_000_000;

async function rejectedAuthCount(): Promise<number> {
  const line = (await getMetrics())
    .split('\n')
    .find((sample) =>
      sample.startsWith('aihub_rejected_total{reason="auth"} '),
    );
  return Number(line?.split(' ').at(-1) ?? 0);
}

function toJwk(key: PublicJsonWebKey): JWK {
  if (
    key['kty'] === 'RSA' &&
    typeof key['n'] === 'string' &&
    typeof key['e'] === 'string'
  ) {
    return { kty: 'RSA', n: key['n'], e: key['e'] };
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
  }): Promise<PublicJsonWebKeySet> {
    return Promise.resolve({ keys: [] });
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

/** A compact JWS whose header is checked before any key or signature is. */
function unsignedAssertion(header: Record<string, unknown>): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part(header)}.${part({})}.c2ln`;
}

/** Flips the first signature character, so the key resolves but cannot verify. */
function tamperedSignature(assertion: string): string {
  const [header, payload, signature = ''] = assertion.split('.');
  return `${header}.${payload}.${
    signature[0] === 'a' ? 'b' : 'a'
  }${signature.slice(1)}`;
}

function verifier(
  provider: JwksKeyProviderPort,
  activeConfig: OrganizationIdentityConfig = {
    ...config,
    publicKeysJwks: null,
  },
  runtimeScope: 'production' | 'sandbox' = 'production',
  replayMarkers: UserAssertionReplayMarkerPort = {
    reserve: async () => true,
  },
) {
  const subject = new UserAssertionVerifier(
    provider,
    new TestUserAssertionCrypto(),
    replayMarkers,
    () => NOW,
    runtimeScope,
  );
  return {
    verify: (input: {
      readonly signedAssertion: string;
      readonly organizationId: string;
    }) => subject.verify({ ...input, config: activeConfig }),
  };
}

describe('UserAssertionVerifier', () => {
  it('rejects a repeated assertion and reserves it through the clock-skew window', async () => {
    const fixture = await rsaFixture();
    const reservations: Parameters<
      UserAssertionReplayMarkerPort['reserve']
    >[0][] = [];
    const replayMarkers: UserAssertionReplayMarkerPort = {
      reserve: async (input) => {
        if (reservations.some((reservation) => reservation.jti === input.jti)) {
          return false;
        }
        reservations.push(input);
        return true;
      },
    };
    const subject = verifier(
      new FakeKeyProvider(fixture.jwks),
      config,
      'production',
      replayMarkers,
    );
    const signedAssertion = await token(fixture.privateKey, {
      expiration: NOW + 100,
      jti: 'single-use-1',
    });
    const input = {
      signedAssertion,
      organizationId: 'org_acme',
    };

    await subject.verify(input);

    await expect(subject.verify(input)).rejects.toMatchObject({
      code: 'INVALID_USER_IDENTITY',
    });
    expect(reservations).toEqual([
      {
        organizationId: 'org_acme',
        environment: 'production',
        jti: 'single-use-1',
        ttlSeconds: 160,
      },
    ]);
  });

  it('fails closed when Redis cannot confirm an assertion reservation', async () => {
    const fixture = await rsaFixture();
    const subject = verifier(
      new FakeKeyProvider(fixture.jwks),
      config,
      'production',
      {
        reserve: async () => {
          throw new Error('redis timeout');
        },
      },
    );
    const signedAssertion = await token(fixture.privateKey, {
      jti: 'redis-unavailable-1',
    });

    await expect(
      subject.verify({
        signedAssertion,
        organizationId: 'org_acme',
      }),
    ).rejects.toMatchObject({
      code: 'IDENTITY_PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

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
      mode: 'signed_assertion',
    });
  });

  it.each([
    ['production', 'aihub', 'sandbox'],
    ['sandbox', 'aihub:sandbox', 'production'],
  ] as const)(
    'accepts only the %s audience for that runtime scope',
    async (scope, acceptedAudience, rejectedAudience) => {
      const fixture = await rsaFixture();
      const subject = verifier(
        new FakeKeyProvider(fixture.jwks),
        config,
        scope,
      );

      await expect(
        subject.verify({
          signedAssertion: await token(fixture.privateKey, {
            audience: acceptedAudience,
            jti: 'jti-1',
          }),
          organizationId: 'org_acme',
        }),
      ).resolves.toMatchObject({ mode: 'signed_assertion' });
      await expect(
        subject.verify({
          signedAssertion: await token(fixture.privateKey, {
            audience: rejectedAudience,
            jti: 'jti-2',
          }),
          organizationId: 'org_acme',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
    },
  );

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
    const before = await rejectedAuthCount();
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
    expect(await rejectedAuthCount()).toBe(before + 2);
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

  it('does not force a second reload when the unknown-kid refresh key still fails', async () => {
    const oldFixture = await rsaFixture('old');
    const newFixture = await rsaFixture('new');
    const assertion = await token(oldFixture.privateKey, {
      kid: 'new',
      jti: 'jti-rotation-forged',
    });
    const provider = new FakeKeyProvider(oldFixture.jwks, newFixture.jwks);

    await expect(
      verifier(provider).verify({
        signedAssertion: assertion,
        organizationId: 'org_acme',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
    expect(provider.calls).toEqual([false, true]);
  });

  it('refreshes once when the key material rotated under the same kid', async () => {
    const oldFixture = await rsaFixture('shared');
    const newFixture = await rsaFixture('shared');
    const assertion = await token(newFixture.privateKey, {
      kid: 'shared',
      jti: 'jti-same-kid-rotation',
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

  it('refreshes once for a same-kid assertion that still fails, not again inside the cooldown', async () => {
    const oldFixture = await rsaFixture('shared');
    const newFixture = await rsaFixture('shared');
    const assertion = await token(oldFixture.privateKey, {
      kid: 'shared',
      jti: 'jti-same-kid-stale',
    });
    const parts = assertion.split('.');
    const signature = parts[2] ?? '';
    const tampered = `${parts[0]}.${parts[1]}.${
      signature[0] === 'a' ? 'b' : 'a'
    }${signature.slice(1)}`;
    const provider = new FakeKeyProvider(oldFixture.jwks, newFixture.jwks);
    const subject = verifier(provider);

    for (const _attempt of [1, 2]) {
      await expect(
        subject.verify({
          signedAssertion: tampered,
          organizationId: 'org_acme',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
    }
    // The second attempt re-reads the cache but does not force a fetch.
    expect(provider.calls).toEqual([false, true, false, false]);
  });

  it('reads the cache a peer refreshed while its own cooldown blocks a reload', async () => {
    const oldFixture = await rsaFixture('shared');
    const newFixture = await rsaFixture('shared');
    const stale = oldFixture.jwks;
    const snapshots = [stale, newFixture.jwks, stale, newFixture.jwks];
    const calls: boolean[] = [];
    const provider: JwksKeyProviderPort = {
      resolve: (input) => {
        calls.push(input.forceRefresh === true);
        return Promise.resolve(snapshots.shift() ?? newFixture.jwks);
      },
      validateRemote: () => Promise.resolve({ keys: [] }),
    };
    const subject = verifier(provider);
    const warmup = await token(oldFixture.privateKey, {
      kid: 'shared',
      jti: 'jti-warmup',
    });
    const [header, payload, signature = ''] = warmup.split('.');
    const tampered = `${header}.${payload}.${
      signature[0] === 'a' ? 'b' : 'a'
    }${signature.slice(1)}`;

    await expect(
      subject.verify({ signedAssertion: tampered, organizationId: 'org_acme' }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });

    await expect(
      subject.verify({
        signedAssertion: await token(newFixture.privateKey, {
          kid: 'shared',
          jti: 'jti-after-peer-refresh',
        }),
        organizationId: 'org_acme',
      }),
    ).resolves.toMatchObject({ userId: 'user_123' });
    expect(calls).toEqual([false, true, false, false]);
  });

  it('keeps a failed rotation reload retryable and reloads again once the provider recovers', async () => {
    const oldFixture = await rsaFixture('shared');
    const newFixture = await rsaFixture('shared');
    let down = true;
    const calls: boolean[] = [];
    const provider: JwksKeyProviderPort = {
      resolve: (input) => {
        const forced = input.forceRefresh === true;
        calls.push(forced);
        if (forced && input.rejectOnRefreshFailure === true && down) {
          return Promise.reject(identityProviderUnavailable());
        }
        return Promise.resolve(forced ? newFixture.jwks : oldFixture.jwks);
      },
      validateRemote: () => Promise.resolve({ keys: [] }),
    };
    const subject = verifier(provider);

    await expect(
      subject.verify({
        signedAssertion: await token(newFixture.privateKey, {
          kid: 'shared',
          jti: 'jti-reload-outage',
        }),
        organizationId: 'org_acme',
      }),
    ).rejects.toMatchObject({
      code: 'IDENTITY_PROVIDER_UNAVAILABLE',
      retryable: true,
    });

    // The failed reload must not hold the cooldown: the next request reloads
    // and accepts the rotated key.
    down = false;
    await expect(
      subject.verify({
        signedAssertion: await token(newFixture.privateKey, {
          kid: 'shared',
          jti: 'jti-reload-recovered',
        }),
        organizationId: 'org_acme',
      }),
    ).resolves.toMatchObject({ userId: 'user_123' });
    expect(calls).toEqual([false, true, false, true]);
  });

  it('answers an unreachable JWKS source with no usable cache as a retryable IDENTITY_PROVIDER_UNAVAILABLE', async () => {
    const fixture = await rsaFixture();
    // What JwksKeyProvider throws when the source is down and no fresh or
    // stale keys remain (jwks-key-provider.spec.ts).
    const sourceDown = new AppError({
      code: 'IDENTITY_JWKS_SOURCE_UNAVAILABLE',
      message: 'JWKS source is unavailable',
      retryable: true,
    });
    const subject = verifier({
      resolve: () => Promise.reject(sourceDown),
      validateRemote: () => Promise.resolve({ keys: [] }),
    });

    await expect(
      subject.verify({
        signedAssertion: await token(fixture.privateKey, {
          jti: 'jti-source-down',
        }),
        organizationId: 'org_acme',
      }),
    ).rejects.toMatchObject({
      code: 'IDENTITY_PROVIDER_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
  });

  it('allows an untracked Organization its first rotation reload when every cooldown is live', async () => {
    const oldFixture = await rsaFixture('shared');
    const newFixture = await rsaFixture('shared');
    const provider = new FakeKeyProvider(oldFixture.jwks, newFixture.jwks);
    const subject = verifier(provider);
    const tampered = tamperedSignature(
      await token(oldFixture.privateKey, {
        kid: 'shared',
        jti: 'jti-fill',
      }),
    );

    for (const index of Array.from({ length: 256 }, (_unused, i) => i)) {
      await expect(
        subject.verify({
          signedAssertion: tampered,
          organizationId: 'org_fill_' + index,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
    }

    provider.calls.length = 0;
    await expect(
      subject.verify({
        signedAssertion: await token(newFixture.privateKey, {
          kid: 'shared',
          jti: 'jti-overflow-first',
        }),
        organizationId: 'org_late',
      }),
    ).resolves.toMatchObject({ userId: 'user_123' });
    expect(provider.calls).toEqual([false, true]);

    // The overflow admission is one per cooldown window, so the next untracked
    // Organization re-reads the cache without forcing another fetch.
    provider.calls.length = 0;
    await expect(
      subject.verify({
        signedAssertion: await token(newFixture.privateKey, {
          kid: 'shared',
          jti: 'jti-overflow-second',
        }),
        organizationId: 'org_later',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
    expect(provider.calls).toEqual([false, false]);
  });

  it('keeps live cooldowns when the rotation-reload map is full', async () => {
    const oldFixture = await rsaFixture('shared');
    const newFixture = await rsaFixture('shared');
    const provider = new FakeKeyProvider(oldFixture.jwks, newFixture.jwks);
    const subject = verifier(provider);
    const tampered = tamperedSignature(
      await token(oldFixture.privateKey, {
        kid: 'shared',
        jti: 'jti-stale',
      }),
    );
    const organizations = Array.from(
      { length: 257 },
      (_unused, index) => `org_fill_${index}`,
    );

    for (const organizationId of organizations) {
      await expect(
        subject.verify({ signedAssertion: tampered, organizationId }),
      ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
    }

    provider.calls.length = 0;
    await expect(
      subject.verify({
        signedAssertion: await token(newFixture.privateKey, {
          kid: 'shared',
          jti: 'jti-after-map-fill',
        }),
        organizationId: organizations[0] ?? '',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
    expect(provider.calls).toEqual([false, false]);
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
    ['an alg other than the token', { alg: 'ES256' }],
    ['a use other than sig', { use: 'enc' }],
    ['key_ops without verify', { key_ops: ['encrypt'] }],
    ['a non-string key_ops entry', { key_ops: ['verify', 7] }],
  ])(
    'refuses a correctly signed assertion whose only key has %s',
    async (_name, override) => {
      const fixture = await rsaFixture();
      const assertion = await token(fixture.privateKey, { jti: 'jti-1' });
      const [key] = fixture.jwks.keys;

      await expect(
        verifier(
          new FakeKeyProvider({ keys: [{ ...key, ...override }] }),
        ).verify({ signedAssertion: assertion, organizationId: 'org_acme' }),
      ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
    },
  );

  it('accepts a key that names sig and verify explicitly', async () => {
    const fixture = await rsaFixture();
    const assertion = await token(fixture.privateKey, { jti: 'jti-1' });
    const [key] = fixture.jwks.keys;

    await expect(
      verifier(
        new FakeKeyProvider({
          keys: [{ ...key, use: 'sig', key_ops: ['verify'] }],
        }),
      ).verify({ signedAssertion: assertion, organizationId: 'org_acme' }),
    ).resolves.toMatchObject({ userId: 'user_123' });
  });

  it('never hands an RSA key to an ES256 verification', async () => {
    const fixture = await rsaFixture();
    const crypto = new TestUserAssertionCrypto();
    const verify = jest.spyOn(crypto, 'verify');
    const subject = new UserAssertionVerifier(
      new FakeKeyProvider(fixture.jwks, fixture.jwks),
      crypto,
      { reserve: async () => true },
      () => NOW,
    );

    await expect(
      subject.verify({
        signedAssertion: unsignedAssertion({ alg: 'ES256', kid: 'rsa-1' }),
        organizationId: 'org_acme',
        config: { ...config, allowedAlgorithms: ['RS256', 'ES256'] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty kid', unsignedAssertion({ alg: 'RS256', kid: '' })],
    ['a numeric kid', unsignedAssertion({ alg: 'RS256', kid: 1 })],
    [
      'more than 32 KiB',
      unsignedAssertion({ alg: 'RS256', pad: 'x'.repeat(32 * 1024) }),
    ],
  ])(
    'refuses an assertion with %s before loading keys',
    async (_name, signedAssertion) => {
      const provider = new FakeKeyProvider({ keys: [] });

      await expect(
        verifier(provider).verify({
          signedAssertion,
          organizationId: 'org_acme',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
      expect(provider.calls).toEqual([]);
    },
  );

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
