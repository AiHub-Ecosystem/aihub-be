import type {
  JwksCacheEntry,
  JwksCachePort,
  JwksCacheSnapshot,
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
  generation = '0';
  readonly versions = new Map<string, JwksCacheEntry>();
  lock: JwksRefreshLock = { acquired: true, available: true };
  setCount = 0;
  failSet = false;

  getJwks(
    _organizationId: string,
    configVersion: string,
  ): Promise<JwksCacheSnapshot> {
    const entry =
      this.versions.get(`${configVersion}:${this.generation}`) ??
      (this.generation === '0' && configVersion === '1'
        ? this.entry
        : undefined);
    return Promise.resolve(
      entry === undefined
        ? { generation: this.generation }
        : { generation: this.generation, entry },
    );
  }

  setJwks(
    _organizationId: string,
    configVersion: string,
    generation: string,
    entry: JwksCacheEntry,
  ): Promise<void> {
    if (this.failSet) {
      return Promise.reject(new Error('cache unavailable'));
    }
    this.versions.set(`${configVersion}:${generation}`, entry);
    this.entry = entry;
    this.setCount += 1;
    return Promise.resolve();
  }

  tryAcquireRefresh(): Promise<JwksRefreshLock> {
    return Promise.resolve(this.lock);
  }

  deleteJwks(_organizationId: string, configVersion: string): Promise<void> {
    this.versions.delete(`${configVersion}:${this.generation}`);
    this.generation = (BigInt(this.generation) + 1n).toString();
    this.entry = undefined;
    return Promise.resolve();
  }
}

function publicLookup(address = '8.8.8.8') {
  return async () => [{ address, family: address.includes(':') ? 6 : 4 }];
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
      redirect: 'manual',
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });
    expect(cache.setCount).toBe(1);
  });

  it('does not let an in-flight old-config fetch repopulate the new cache version', async () => {
    const cache = new FakeCache();
    let finishOldFetch: ((response: Response) => void) | undefined;
    let markOldFetchStarted: (() => void) | undefined;
    const oldFetchStarted = new Promise<void>((resolve) => {
      markOldFetchStarted = resolve;
    });
    let fetchCount = 0;
    const provider = new JwksKeyProvider(
      cache,
      async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          markOldFetchStarted?.();
          return new Promise<Response>((resolve) => {
            finishOldFetch = resolve;
          });
        }
        return new Response(JSON.stringify(jwks));
      },
      publicLookup(),
    );

    const oldResolution = provider.resolve({
      organizationId: 'org_acme',
      config: { ...remoteConfig, jwksCacheVersion: '1' },
    });
    await oldFetchStarted;
    await cache.deleteJwks('org_acme', '1');
    finishOldFetch?.(new Response(JSON.stringify(jwks)));
    await oldResolution;

    await expect(
      provider.resolve({
        organizationId: 'org_acme',
        config: { ...remoteConfig, jwksCacheVersion: '2' },
      }),
    ).resolves.toEqual(jwks);
    expect(fetchCount).toBe(2);
  });

  it('does not let an in-flight fetch survive a retry purge for an unchanged config', async () => {
    const cache = new FakeCache();
    let finishOldFetch: ((response: Response) => void) | undefined;
    let markOldFetchStarted: (() => void) | undefined;
    const oldFetchStarted = new Promise<void>((resolve) => {
      markOldFetchStarted = resolve;
    });
    let fetchCount = 0;
    const provider = new JwksKeyProvider(
      cache,
      async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          markOldFetchStarted?.();
          return new Promise<Response>((resolve) => {
            finishOldFetch = resolve;
          });
        }
        return new Response(JSON.stringify(jwks));
      },
      publicLookup(),
    );
    const unchangedConfig = { ...remoteConfig, jwksCacheVersion: '1' };

    const oldResolution = provider.resolve({
      organizationId: 'org_acme',
      config: unchangedConfig,
    });
    await oldFetchStarted;
    await cache.deleteJwks('org_acme', '1');
    finishOldFetch?.(new Response(JSON.stringify(jwks)));
    await oldResolution;

    await expect(
      provider.resolve({
        organizationId: 'org_acme',
        config: unchangedConfig,
      }),
    ).resolves.toEqual(jwks);
    expect(fetchCount).toBe(2);
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

  it('validates a URL with one protected fetch while bypassing fresh cache data', async () => {
    const cache = new FakeCache();
    cache.entry = {
      jwks: { keys: [] },
      freshUntil: 10_000,
      staleUntil: 20_000,
    };
    let fetches = 0;
    let lookups = 0;
    const provider = new JwksKeyProvider(
      cache,
      async () => {
        fetches += 1;
        return new Response(JSON.stringify(jwks));
      },
      async () => {
        lookups += 1;
        return [{ address: '8.8.8.8', family: 4 }];
      },
      () => 1_000,
    );

    await provider.validateRemote(remoteConfig.jwksUrl ?? '');

    expect(fetches).toBe(1);
    expect(lookups).toBe(1);
    expect(cache.setCount).toBe(0);
    expect(cache.entry?.jwks).toEqual({ keys: [] });
  });

  it('does not accept an unsafe URL from cached keys during save validation', async () => {
    const cache = new FakeCache();
    cache.entry = { jwks, freshUntil: 10_000, staleUntil: 20_000 };
    const fetcher = jest.fn(async () => new Response(JSON.stringify(jwks)));
    const provider = new JwksKeyProvider(
      cache,
      fetcher,
      publicLookup('127.0.0.1'),
      () => 1_000,
    );

    await expect(
      provider.validateRemote(remoteConfig.jwksUrl ?? ''),
    ).rejects.toMatchObject({
      code: 'IDENTITY_JWKS_URL_UNSAFE',
      retryable: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('classifies non-HTTPS URLs as unsafe during save validation', async () => {
    const provider = new JwksKeyProvider(
      new FakeCache(),
      async () => new Response(JSON.stringify(jwks)),
      publicLookup(),
    );

    await expect(
      provider.validateRemote('http://id.acme.edu/keys'),
    ).rejects.toMatchObject({
      code: 'IDENTITY_JWKS_URL_UNSAFE',
      httpStatus: 400,
      retryable: false,
    });
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
    ['http://id.acme.edu/keys', '8.8.8.8'],
    ['https://user:password@id.acme.edu/keys', '8.8.8.8'],
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

  it.each([
    '192.0.2.10',
    '192.88.99.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.10',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '100::1',
    '5f00::1',
    '2001:db8::1',
    '3fff::1',
    '64:ff9b:1::a00:1',
    '2002:c000:0201::1',
  ])(
    'rejects reserved address range %s during uncached validation',
    async (address) => {
      const fetcher = jest.fn(async () => new Response(JSON.stringify(jwks)));
      const provider = new JwksKeyProvider(
        new FakeCache(),
        fetcher,
        publicLookup(address),
      );

      await expect(
        provider.validateRemote(remoteConfig.jwksUrl ?? ''),
      ).rejects.toMatchObject({
        code: 'IDENTITY_JWKS_URL_UNSAFE',
        retryable: false,
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('classifies rejected redirects as unsafe without following them', async () => {
    let redirectMode: string | undefined;
    const provider = new JwksKeyProvider(
      new FakeCache(),
      async (_url, init) => {
        redirectMode = init?.redirect;
        return new Response('', {
          status: 302,
          headers: { location: 'http://127.0.0.1/internal' },
        });
      },
      publicLookup(),
    );

    await expect(
      provider.validateRemote(remoteConfig.jwksUrl ?? ''),
    ).rejects.toMatchObject({
      code: 'IDENTITY_JWKS_URL_UNSAFE',
      retryable: false,
    });
    expect(redirectMode).toBe('manual');
  });

  it('classifies DNS and network failures as retryable source unavailability', async () => {
    const dnsFailure = new JwksKeyProvider(
      new FakeCache(),
      async () => new Response(JSON.stringify(jwks)),
      async () => Promise.reject(new Error('private DNS details')),
    );
    await expect(
      dnsFailure.validateRemote(remoteConfig.jwksUrl ?? ''),
    ).rejects.toMatchObject({
      code: 'IDENTITY_JWKS_SOURCE_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });

    const networkFailure = new JwksKeyProvider(
      new FakeCache(),
      async () => Promise.reject(new Error('private network details')),
      publicLookup(),
    );
    await expect(
      networkFailure.validateRemote(remoteConfig.jwksUrl ?? ''),
    ).rejects.toMatchObject({
      code: 'IDENTITY_JWKS_SOURCE_UNAVAILABLE',
      retryable: true,
      message: 'JWKS source is unavailable',
    });
  });

  it.each([
    [401, false],
    [404, false],
    [408, true],
    [425, true],
    [429, true],
    [500, true],
  ])(
    'classifies unsuccessful JWKS response %s as retryable=%s',
    async (status, retryable) => {
      const provider = new JwksKeyProvider(
        new FakeCache(),
        async () => new Response('', { status }),
        publicLookup(),
      );

      await expect(
        provider.validateRemote(remoteConfig.jwksUrl ?? ''),
      ).rejects.toMatchObject({
        code: 'IDENTITY_JWKS_SOURCE_UNAVAILABLE',
        httpStatus: 503,
        retryable,
      });
    },
  );

  it.each(['not-json', '{"keys":[]}', '{"keys":[{"kty":"oct"}]}'])(
    'classifies unsupported JWKS content as invalid without echoing it',
    async (body) => {
      const provider = new JwksKeyProvider(
        new FakeCache(),
        async () => new Response(body),
        publicLookup(),
      );

      await expect(
        provider.validateRemote(remoteConfig.jwksUrl ?? ''),
      ).rejects.toMatchObject({
        code: 'IDENTITY_JWKS_INVALID',
        httpStatus: 400,
        retryable: false,
        message: 'Public JWKS is invalid',
      });
    },
  );

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
