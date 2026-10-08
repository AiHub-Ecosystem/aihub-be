import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici';

import { AppError } from '@/common/errors/app-error';
import { parsePublicJsonWebKeySet } from '@/modules/identity/domain/organization-identity-config';
import type {
  OrganizationIdentityConfig,
  PublicJsonWebKeySet,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import type {
  JwksCacheEntry,
  JwksCachePort,
  JwksRefreshLock,
} from '@/modules/identity/user-assertions/application/jwks-cache.port';
import type { JwksKeyProviderPort } from '@/modules/identity/user-assertions/application/jwks-key-provider.port';
import { identityProviderUnavailable } from '@/modules/identity/user-assertions/application/user-identity-errors';

export const JWKS_FRESH_TTL_MS = 15 * 60 * 1_000;
export const JWKS_STALE_TTL_MS = 24 * 60 * 60 * 1_000;
export const JWKS_REFRESH_COOLDOWN_MS = 5 * 60 * 1_000;
export const JWKS_DNS_TIMEOUT_MS = 1_000;
export const JWKS_FETCH_TIMEOUT_MS = 3_000;
export const JWKS_MAX_RESPONSE_BYTES = 64 * 1024;
export const JWKS_MAX_CONCURRENT_ORGANIZATIONS = 8;
const JWKS_DISPATCHER = Symbol('JWKS_DISPATCHER');

interface DnsAddress {
  readonly address: string;
  readonly family: number;
}

interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  cancel(): void;
}

type DnsResolverFactory = () => DnsResolver;

const defaultResolverFactory: DnsResolverFactory = () =>
  new Resolver({ timeout: JWKS_DNS_TIMEOUT_MS, tries: 1 });

interface FetchInit {
  readonly [JWKS_DISPATCHER]?: Dispatcher;
  readonly redirect?: 'error' | 'manual';
  readonly credentials?: 'omit';
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

type Fetcher = (url: string, init?: FetchInit) => Promise<FetchResponse>;

const defaultFetcher: Fetcher = (url, init) => {
  const dispatcher = init?.[JWKS_DISPATCHER];

  return undiciFetch(url, {
    ...(dispatcher === undefined ? {} : { dispatcher }),
    ...(init?.redirect === undefined ? {} : { redirect: init.redirect }),
    ...(init?.credentials === undefined
      ? {}
      : { credentials: init.credentials }),
    ...(init?.headers === undefined ? {} : { headers: init.headers }),
    ...(init?.signal === undefined ? {} : { signal: init.signal }),
  });
};

function unsafeUrl(): AppError {
  return new AppError({
    code: 'IDENTITY_JWKS_URL_UNSAFE',
    message: 'JWKS URL is not safe',
    retryable: false,
  });
}

function sourceUnavailable(retryable: boolean, cause?: unknown): AppError {
  return new AppError({
    code: 'IDENTITY_JWKS_SOURCE_UNAVAILABLE',
    message: 'JWKS source is unavailable',
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });
}

function invalidJwks(): AppError {
  return new AppError({
    code: 'IDENTITY_JWKS_INVALID',
    message: 'Public JWKS is invalid',
    retryable: false,
  });
}

function ipv4Number(address: string): number | undefined {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return undefined;
  }

  return (
    (((octets[0] ?? 0) * 256 + (octets[1] ?? 0)) * 256 + (octets[2] ?? 0)) *
      256 +
    (octets[3] ?? 0)
  );
}

function isUnsafeIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === undefined) {
    return true;
  }

  const inRange = (start: string, end: string): boolean => {
    const first = ipv4Number(start);
    const last = ipv4Number(end);
    return (
      first !== undefined &&
      last !== undefined &&
      value >= first &&
      value <= last
    );
  };

  return [
    ['0.0.0.0', '0.255.255.255'],
    ['10.0.0.0', '10.255.255.255'],
    ['100.64.0.0', '100.127.255.255'],
    ['127.0.0.0', '127.255.255.255'],
    ['169.254.0.0', '169.254.255.255'],
    ['172.16.0.0', '172.31.255.255'],
    ['192.0.0.0', '192.0.0.255'],
    ['192.0.2.0', '192.0.2.255'],
    ['192.88.99.0', '192.88.99.255'],
    ['192.168.0.0', '192.168.255.255'],
    ['198.18.0.0', '198.19.255.255'],
    ['198.51.100.0', '198.51.100.255'],
    ['203.0.113.0', '203.0.113.255'],
    ['224.0.0.0', '239.255.255.255'],
    ['240.0.0.0', '255.255.255.255'],
  ].some(([start, end]) => inRange(start ?? '', end ?? ''));
}

function ipv6Hextets(address: string): readonly number[] | undefined {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  const halves = normalized.split('::');
  if (halves.length > 2) {
    return undefined;
  }

  const parsePart = (part: string): number[] | undefined => {
    if (part.length === 0) {
      return [];
    }

    const parsed: number[] = [];
    for (const token of part.split(':')) {
      if (token.includes('.')) {
        const value = ipv4Number(token);
        if (value === undefined) {
          return undefined;
        }
        parsed.push((value >>> 16) & 0xffff, value & 0xffff);
        continue;
      }

      if (!/^[0-9a-f]{1,4}$/.test(token)) {
        return undefined;
      }
      parsed.push(Number.parseInt(token, 16));
    }
    return parsed;
  };

  const left = parsePart(halves[0] ?? '');
  const right = halves.length === 2 ? parsePart(halves[1] ?? '') : [];
  if (left === undefined || right === undefined) {
    return undefined;
  }

  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) {
    return undefined;
  }

  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function isUnsafeIpv6(address: string): boolean {
  const parts = ipv6Hextets(address);
  if (parts === undefined || parts.length !== 8) {
    return true;
  }

  const first = parts[0] ?? 0;
  const isIetfProtocolAssignment =
    first === 0x2001 && (parts[1] ?? 0) <= 0x01ff;
  const isDocumentation =
    (first === 0x2001 && parts[1] === 0x0db8) ||
    (first === 0x3fff && (parts[1] ?? 0) <= 0x0fff);
  const isSixToFour = first === 0x2002;
  const isNotGlobalUnicast = first < 0x2000 || first > 0x3fff;

  return (
    isNotGlobalUnicast ||
    isIetfProtocolAssignment ||
    isDocumentation ||
    isSixToFour
  );
}

function isUnsafeAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? isUnsafeIpv4(address)
    : family === 6
      ? isUnsafeIpv6(address)
      : true;
}

function isNoDnsRecord(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENODATA' || error.code === 'ENOTFOUND')
  );
}

async function resolveHost(
  hostname: string,
  resolverFactory: DnsResolverFactory,
  deadlineAt: number,
): Promise<readonly DnsAddress[]> {
  const normalizedHost = hostname.replace(/^\[|\]$/g, '');
  const family = isIP(normalizedHost);
  if (family === 4 || family === 6) {
    return [{ address: normalizedHost, family }];
  }

  const resolver = resolverFactory();
  try {
    const dnsDeadlineAt = Math.min(
      deadlineAt,
      Date.now() + JWKS_DNS_TIMEOUT_MS,
    );
    const [ipv4, ipv6] = await withDeadline(
      Promise.allSettled([
        resolver.resolve4(normalizedHost),
        resolver.resolve6(normalizedHost),
      ]),
      dnsDeadlineAt,
    );
    const addresses: DnsAddress[] = [];
    for (const [result, addressFamily] of [
      [ipv4, 4],
      [ipv6, 6],
    ] as const) {
      if (result.status === 'fulfilled') {
        addresses.push(
          ...result.value.map((address) => ({
            address,
            family: addressFamily,
          })),
        );
      } else if (!isNoDnsRecord(result.reason)) {
        throw result.reason;
      }
    }
    return addresses;
  } catch (error) {
    resolver.cancel();
    throw error;
  }
}

async function assertSafeHost(
  hostname: string,
  resolverFactory: DnsResolverFactory,
  deadlineAt: number,
): Promise<readonly DnsAddress[]> {
  let addresses: readonly DnsAddress[];
  try {
    addresses = await withDeadline(
      resolveHost(hostname, resolverFactory, deadlineAt),
      deadlineAt,
    );
  } catch (cause) {
    throw sourceUnavailable(true, cause);
  }
  if (addresses.length === 0) {
    throw sourceUnavailable(true);
  }
  if (addresses.some((address) => isUnsafeAddress(address.address))) {
    throw unsafeUrl();
  }
  return addresses;
}

async function withDeadline<T>(
  operation: Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error('JWKS lookup timed out');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('JWKS lookup timed out')),
      remainingMs,
    );
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function pinnedLookup(addresses: readonly DnsAddress[]) {
  return (
    _hostname: string,
    options: import('node:dns').LookupOptions,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | DnsAddress[],
      family?: number,
    ) => void,
  ): void => {
    if (options.all === true) {
      callback(null, [...addresses]);
      return;
    }

    const address = addresses[0];
    if (address === undefined) {
      callback(
        Object.assign(new Error('No public JWKS address'), {
          code: 'ENOTFOUND',
        }),
        '',
        0,
      );
      return;
    }
    callback(null, address.address, address.family);
  };
}

async function readLimitedBody(response: FetchResponse): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > JWKS_MAX_RESPONSE_BYTES
    ) {
      throw invalidJwks();
    }
  }

  if (response.body === null) {
    throw invalidJwks();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const next = await reader.read().catch((cause: unknown) => {
        throw sourceUnavailable(true, cause);
      });
      if (next.done) {
        break;
      }

      total += next.value.byteLength;
      if (total > JWKS_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw invalidJwks();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString('utf8');
}

export class JwksKeyProvider implements JwksKeyProviderPort {
  private readonly localRefreshCooldown = new Map<string, number>();
  private readonly refreshLockFlights = new Map<
    string,
    Promise<JwksRefreshLock>
  >();
  private readonly flights = new Map<
    string,
    {
      readonly key: string;
      readonly promise: Promise<PublicJsonWebKeySet>;
    }
  >();

  constructor(
    private readonly cache: JwksCachePort,
    private readonly fetcher: Fetcher = defaultFetcher,
    private readonly resolverFactory: DnsResolverFactory = defaultResolverFactory,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async validateRemote(input: {
    readonly organizationId: string;
    readonly url: string;
  }): Promise<void> {
    const snapshot = await this.cache.getJwks(input.organizationId, '1');
    await this.fetchRemoteForOrganization(
      input.organizationId,
      input.url,
      JSON.stringify([snapshot.generation, input.url]),
    );
  }

  async resolve(input: {
    readonly organizationId: string;
    readonly config: OrganizationIdentityConfig;
    readonly forceRefresh?: boolean;
  }): Promise<PublicJsonWebKeySet> {
    if (input.config.jwksUrl === null) {
      if (input.config.publicKeysJwks === null) {
        throw identityProviderUnavailable();
      }
      return input.config.publicKeysJwks;
    }

    const configVersion = input.config.jwksCacheVersion ?? '1';
    const snapshot = await this.cache.getJwks(
      input.organizationId,
      configVersion,
    );
    const cacheGeneration = snapshot.generation;
    const cached = snapshot.entry;
    const now = this.now();

    if (
      !input.forceRefresh &&
      cached !== undefined &&
      cached.freshUntil > now
    ) {
      return cached.jwks;
    }

    const flightKey = JSON.stringify([cacheGeneration, input.config.jwksUrl]);
    const activeFlight = this.flights.get(input.organizationId);

    if (
      input.forceRefresh &&
      activeFlight === undefined &&
      this.flights.size < JWKS_MAX_CONCURRENT_ORGANIZATIONS
    ) {
      const lock = await this.acquireRefreshLock(input.organizationId);
      if (!lock.available) {
        if (!this.flights.has(input.organizationId)) {
          const cooldownUntil = this.localRefreshCooldown.get(
            input.organizationId,
          );
          if (cooldownUntil !== undefined && cooldownUntil > now) {
            return cached?.jwks ?? { keys: [] };
          }
          this.localRefreshCooldown.set(
            input.organizationId,
            now + JWKS_REFRESH_COOLDOWN_MS,
          );
        }
      } else if (!lock.acquired) {
        const reread = await this.cache.getJwks(
          input.organizationId,
          configVersion,
        );
        return reread.generation === cacheGeneration
          ? (reread.entry?.jwks ?? cached?.jwks ?? { keys: [] })
          : { keys: [] };
      }
    }

    try {
      const jwks = await this.fetchRemoteForOrganization(
        input.organizationId,
        input.config.jwksUrl,
        flightKey,
      );
      const entry: JwksCacheEntry = {
        jwks,
        freshUntil: now + JWKS_FRESH_TTL_MS,
        staleUntil: now + JWKS_STALE_TTL_MS,
      };
      await this.cache
        .setJwks(input.organizationId, configVersion, cacheGeneration, entry)
        .catch(() => undefined);
      return jwks;
    } catch (error) {
      if (cached !== undefined && cached.staleUntil > now) {
        return cached.jwks;
      }
      throw identityProviderUnavailable(error);
    }
  }

  private acquireRefreshLock(organizationId: string): Promise<JwksRefreshLock> {
    const existing = this.refreshLockFlights.get(organizationId);
    if (existing !== undefined) {
      return existing;
    }

    let flight: Promise<JwksRefreshLock>;
    flight = this.cache.tryAcquireRefresh(organizationId).finally(() => {
      if (this.refreshLockFlights.get(organizationId) === flight) {
        this.refreshLockFlights.delete(organizationId);
      }
    });
    this.refreshLockFlights.set(organizationId, flight);
    return flight;
  }

  private fetchRemoteForOrganization(
    organizationId: string,
    url: string,
    key = url,
  ): Promise<PublicJsonWebKeySet> {
    const existing = this.flights.get(organizationId);
    if (existing !== undefined) {
      return existing.key === key
        ? existing.promise
        : Promise.reject(sourceUnavailable(true));
    }
    if (this.flights.size >= JWKS_MAX_CONCURRENT_ORGANIZATIONS) {
      return Promise.reject(sourceUnavailable(true));
    }

    let flight: {
      readonly key: string;
      readonly promise: Promise<PublicJsonWebKeySet>;
    };
    const promise = Promise.resolve()
      .then(() => this.fetchRemote(url))
      .finally(() => {
        if (this.flights.get(organizationId) === flight) {
          this.flights.delete(organizationId);
        }
      });
    flight = { key, promise };
    this.flights.set(organizationId, flight);
    return promise;
  }

  private async fetchRemote(urlValue: string): Promise<PublicJsonWebKeySet> {
    let url: URL;
    try {
      url = new URL(urlValue);
    } catch (error) {
      throw new Error('JWKS URL is invalid', { cause: error });
    }

    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw unsafeUrl();
    }

    const deadlineAt = Date.now() + JWKS_FETCH_TIMEOUT_MS;
    const addresses = await assertSafeHost(
      url.hostname,
      this.resolverFactory,
      deadlineAt,
    );
    const remainingMs = Math.max(1, deadlineAt - Date.now());
    const dispatcher = new Agent({
      connect: {
        lookup: pinnedLookup(addresses),
        timeout: remainingMs,
      },
      connections: 1,
    });

    try {
      let response: FetchResponse;
      try {
        response = await this.fetcher(url.toString(), {
          [JWKS_DISPATCHER]: dispatcher,
          redirect: 'manual',
          credentials: 'omit',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(remainingMs),
        });
      } catch (cause) {
        throw sourceUnavailable(true, cause);
      }

      if (response.status >= 300 && response.status < 400) {
        throw unsafeUrl();
      }
      if (!response.ok) {
        const retryable =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        throw sourceUnavailable(retryable);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readLimitedBody(response));
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw invalidJwks();
      }
      const jwks = parsePublicJsonWebKeySet(parsed);
      if (jwks === undefined) {
        throw invalidJwks();
      }

      return jwks;
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }
}
