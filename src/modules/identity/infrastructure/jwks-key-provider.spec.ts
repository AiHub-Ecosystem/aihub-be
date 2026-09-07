import type {
  JwksCacheEntry,
  JwksCachePort,
  JwksRefreshLock,
} from '../application/jwks-cache.port';
import type { OrganizationIdentityConfig } from '../application/organization-identity-config-repository.port';
import { JWKS_MAX_RESPONSE_BYTES, JwksKeyProvider } from './jwks-key-provider';

const jwks = {
  keys: [
    {
      kty: 'RSA',
      n: 'modulus',
      e: 'AQAB',
      alg: 'RS256',
      kid: 'rsa-1',
    },
  ],
};

const remoteConfig: OrganizationIdentityConfig = {
  organizationId: 'org_acme',
  issuer: 'https://acme.edu',
  jwksUrl: 'https://id.acme.edu/.well-known/jwks.json',
  publicKeysJwks: null,
  allowedAlgorithms: ['RS256'],
  maxAssertionTtlSeconds: 300,
  status: 'active',
};

class FakeCache implements JwksCachePort {
  entry: JwksCacheEntry | undefined;
  lock: JwksRefreshLock = { acquired: true, available: true };
  setCount = 0;
  failSet = false;

  getJwks(): Promise<JwksCacheEntry | undefined> {
    return Promise.resolve(this.entry);
  }

  setJwks(_organizationId: string, entry: JwksCacheEntry): Promise<void> {
    if (this.failSet) {
      return Promise.reject(new Error('cache unavailable'));
    }
    this.entry = entry;
    this.setCount += 1;
    return Promise.resolve();
  }

  tryAcquireRefresh(): Promise<JwksRefreshLock> {
    return Promise.resolve(this.lock);
  }
}

function publicLookup(address = '203.0.113.10') {
  return async () => [{ address, family: 4 }];
}

function configWithUrl(jwksUrl: string): OrganizationIdentityConfig {
  return { ...remoteConfig, jwksUrl };
}

describe('JwksKeyProvider', () => {
  it('fetches, validates, and caches a remote JWKS without credentials or redirects', async () => {
    const cache = new FakeCache();
    const requests: RequestInit[] = [];
    const provider = new JwksKeyProvider(
      cache,
      async (_url, init) => {
        requests.push(init ?? {});
        return new Response(JSON.stringify(jwks), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      publicLookup(),
      () => 1_000_000,
    );

    await expect(
      provider.resolve({ organizationId: 'org_acme', config: remoteConfig }),
    ).resolves.toEqual(jwks);
    expect(requests[0]).toMatchObject({
      redirect: 'error',
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });
    expect(cache.setCount).toBe(1);
  });

  it('uses a fresh cache entry without fetching again', async () => {
    const cache = new FakeCache();
    cache.entry = {
      jwks,
      freshUntil: 2_000,
      staleUntil: 3_000,
    };
    let fetches = 0;
    const provider = new JwksKeyProvider(
      cache,
      async () => {
        fetches += 1;
        return new Response(JSON.stringify(jwks));
      },
      publicLookup(),
      () => 1_000,
    );

    await expect(
      provider.resolve({ organizationId: 'org_acme', config: remoteConfig }),
    ).resolves.toEqual(jwks);
    expect(fetches).toBe(0);
  });

  it('returns fetched keys when the cache write is unavailable', async () => {
    const cache = new FakeCache();
    cache.failSet = true;
    const provider = new JwksKeyProvider(
      cache,
      async () => new Response(JSON.stringify(jwks)),
      publicLookup(),
      () => 1_000,
    );

    await expect(
      provider.resolve({ organizationId: 'org_acme', config: remoteConfig }),
    ).resolves.toEqual(jwks);
  });

  it('serves stale keys when a refresh fails within the stale window', async () => {
    const cache = new FakeCache();
    cache.entry = { jwks, freshUntil: 1_000, staleUntil: 3_000 };
    const provider = new JwksKeyProvider(
      cache,
      async () => Promise.reject(new Error('provider down')),
      publicLookup(),
      () => 2_000,
    );

    await expect(
      provider.resolve({ organizationId: 'org_acme', config: remoteConfig }),
    ).resolves.toEqual(jwks);
  });

  it('returns the contracted unavailable error when there is no usable cache', async () => {
    const provider = new JwksKeyProvider(
      new FakeCache(),
      async () => Promise.reject(new Error('provider down')),
      publicLookup(),
      () => 2_000,
    );

    await expect(
      provider.resolve({ organizationId: 'org_acme', config: remoteConfig }),
    ).rejects.toMatchObject({
      code: 'IDENTITY_PROVIDER_UNAVAILABLE',
      httpStatus: 503,
    });
  });

  it.each([
    ['http://id.acme.edu/keys', '203.0.113.10'],
    ['https://user:password@id.acme.edu/keys', '203.0.113.10'],
    ['https://id.acme.edu/keys', '169.254.169.254'],
  ])('rejects unsafe JWKS URL %s', async (url, address) => {
    const fetcher = jest.fn(async () => new Response(JSON.stringify(jwks)));
    const provider = new JwksKeyProvider(
      new FakeCache(),
      fetcher,
      publicLookup(address),
      () => 1_000,
    );

    await expect(
      provider.resolve({
        organizationId: 'org_acme',
        config: configWithUrl(url),
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_PROVIDER_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a response over the 64KB cap before caching it', async () => {
    const cache = new FakeCache();
    const provider = new JwksKeyProvider(
      cache,
      async () =>
        new Response(JSON.stringify(jwks), {
          headers: { 'content-length': String(JWKS_MAX_RESPONSE_BYTES + 1) },
        }),
      publicLookup(),
      () => 1_000,
    );

    await expect(
      provider.resolve({ organizationId: 'org_acme', config: remoteConfig }),
    ).rejects.toMatchObject({ code: 'IDENTITY_PROVIDER_UNAVAILABLE' });
    expect(cache.setCount).toBe(0);
  });

  it('keeps inline-only configuration independent of the network and cache', async () => {
    const cache = new FakeCache();
    const fetcher = jest.fn(async () => new Response('not used'));
    const provider = new JwksKeyProvider(cache, fetcher, publicLookup());

    await expect(
      provider.resolve({
        organizationId: 'org_acme',
        config: {
          ...remoteConfig,
          jwksUrl: null,
          publicKeysJwks: jwks,
        },
      }),
    ).resolves.toEqual(jwks);
    expect(fetcher).not.toHaveBeenCalled();
    expect(cache.setCount).toBe(0);
  });
});
