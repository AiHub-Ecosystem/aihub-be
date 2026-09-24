import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici';

import { AppError } from '../../../common/errors/app-error';
import type {
  JwksCacheEntry,
  JwksCachePort,
} from '../application/jwks-cache.port';
import type { JwksKeyProviderPort } from '../application/jwks-key-provider.port';
import type {
  OrganizationIdentityConfig,
  PublicJsonWebKeySet,
} from '../application/organization-identity-config-repository.port';
import { parsePublicJsonWebKeySet } from '../domain/organization-identity-config';

export const JWKS_FRESH_TTL_MS = 15 * 60 * 1_000;
export const JWKS_STALE_TTL_MS = 24 * 60 * 60 * 1_000;
export const JWKS_REFRESH_COOLDOWN_MS = 5 * 60 * 1_000;
export const JWKS_FETCH_TIMEOUT_MS = 3_000;
export const JWKS_MAX_RESPONSE_BYTES = 64 * 1024;
const JWKS_DISPATCHER = Symbol('JWKS_DISPATCHER');

interface DnsAddress {
  readonly address: string;
  readonly family: number;
}

type DnsLookup = (
  hostname: string,
  options: { readonly all: true; readonly verbatim: true },
) => Promise<readonly DnsAddress[]>;

interface FetchInit {
  readonly [JWKS_DISPATCHER]?: Dispatcher;
  readonly redirect?: 'error';
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

function unavailable(cause?: unknown): AppError {
  return new AppError({
    code: 'IDENTITY_PROVIDER_UNAVAILABLE',
    message: 'Identity provider is unavailable',
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
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

async function defaultLookup(
  hostname: string,
  options: { readonly all: true; readonly verbatim: true },
): Promise<readonly DnsAddress[]> {
  const normalizedHost = hostname.replace(/^\[|\]$/g, '');
  const family = isIP(normalizedHost);
  if (family === 4 || family === 6) {
    return [{ address: normalizedHost, family }];
  }

  return (await dnsLookup(normalizedHost, options)).flatMap((address) =>
    address.family === 4 || address.family === 6
      ? [{ address: address.address, family: address.family }]
      : [],
  );
}

async function assertSafeHost(
  hostname: string,
  lookup: DnsLookup,
  deadlineAt: number,
): Promise<readonly DnsAddress[]> {
  const addresses = await withDeadline(
    lookup(hostname, { all: true, verbatim: true }),
    deadlineAt,
  );
  if (
    addresses.length === 0 ||
    addresses.some((address) => isUnsafeAddress(address.address))
  ) {
    throw new Error('JWKS host resolves to a blocked address');
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
      throw new Error('JWKS response is too large');
    }
  }

  if (response.body === null) {
    throw new Error('JWKS response has no body');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }

      total += next.value.byteLength;
      if (total > JWKS_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('JWKS response is too large');
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

  constructor(
    private readonly cache: JwksCachePort,
    private readonly fetcher: Fetcher = defaultFetcher,
    private readonly lookup: DnsLookup = defaultLookup,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async validateRemote(url: string): Promise<void> {
    await this.fetchRemote(url);
  }

  async resolve(input: {
    readonly organizationId: string;
    readonly config: OrganizationIdentityConfig;
    readonly forceRefresh?: boolean;
  }): Promise<PublicJsonWebKeySet> {
    if (input.config.jwksUrl === null) {
      if (input.config.publicKeysJwks === null) {
        throw unavailable();
      }
      return input.config.publicKeysJwks;
    }

    const cacheVersion = input.config.jwksCacheVersion ?? '1';
    const cached = await this.cache.getJwks(input.organizationId, cacheVersion);
    const now = this.now();

    if (
      !input.forceRefresh &&
      cached !== undefined &&
      cached.freshUntil > now
    ) {
      return cached.jwks;
    }

    if (input.forceRefresh) {
      const lock = await this.cache.tryAcquireRefresh(input.organizationId);
      if (!lock.available) {
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
      } else if (!lock.acquired) {
        const reread = await this.cache.getJwks(
          input.organizationId,
          cacheVersion,
        );
        return reread?.jwks ?? cached?.jwks ?? { keys: [] };
      }
    }

    try {
      const jwks = await this.fetchRemote(input.config.jwksUrl);
      const entry: JwksCacheEntry = {
        jwks,
        freshUntil: now + JWKS_FRESH_TTL_MS,
        staleUntil: now + JWKS_STALE_TTL_MS,
      };
      await this.cache
        .setJwks(input.organizationId, cacheVersion, entry)
        .catch(() => undefined);
      return jwks;
    } catch (error) {
      if (cached !== undefined && cached.staleUntil > now) {
        return cached.jwks;
      }
      throw unavailable(error);
    }
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
      throw new Error('JWKS URL must use HTTPS without credentials');
    }

    const deadlineAt = Date.now() + JWKS_FETCH_TIMEOUT_MS;
    const addresses = await assertSafeHost(
      url.hostname,
      this.lookup,
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
      const response = await this.fetcher(url.toString(), {
        [JWKS_DISPATCHER]: dispatcher,
        redirect: 'error',
        credentials: 'omit',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(remainingMs),
      });

      if (!response.ok) {
        throw new Error(`JWKS endpoint returned ${response.status}`);
      }

      const parsed: unknown = JSON.parse(await readLimitedBody(response));
      const jwks = parsePublicJsonWebKeySet(parsed);
      if (jwks === undefined) {
        throw new Error('JWKS response is invalid');
      }

      return jwks;
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }
}
