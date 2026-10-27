import { Resolver } from 'node:dns/promises';
import { type LookupFunction, isIP } from 'node:net';

import { unsafeJwksUrl } from '@/modules/identity/shared/application/jwks-errors';
import { sourceUnavailable } from './jwks-source-errors';

const JWKS_DNS_TIMEOUT_MS = 1_000;

interface DnsAddress {
  readonly address: string;
  readonly family: number;
}

interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  cancel(): void;
}

export type DnsResolverFactory = () => DnsResolver;

type DnsResult<T> = PromiseSettledResult<T>;

export const defaultJwksResolverFactory: DnsResolverFactory = () =>
  new Resolver({ timeout: JWKS_DNS_TIMEOUT_MS, tries: 1 });

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
  let cancelled = false;
  const cancelResolver = () => {
    if (!cancelled) {
      cancelled = true;
      resolver.cancel();
    }
  };
  try {
    const dnsDeadlineAt = Math.min(
      deadlineAt,
      Date.now() + JWKS_DNS_TIMEOUT_MS,
    );
    let ipv4: DnsResult<string[]> | undefined;
    let ipv6: DnsResult<string[]> | undefined;
    const resolve = <T>(operation: () => Promise<T>) => {
      try {
        return operation().then<DnsResult<T>, DnsResult<T>>(
          (value) => ({ status: 'fulfilled', value }),
          (reason: unknown) => ({ status: 'rejected', reason }),
        );
      } catch (reason) {
        return Promise.resolve<DnsResult<T>>({ status: 'rejected', reason });
      }
    };
    const ipv4Lookup = resolve(() => resolver.resolve4(normalizedHost)).then(
      (result) => (ipv4 = result),
    );
    const ipv6Lookup = resolve(() => resolver.resolve6(normalizedHost)).then(
      (result) => (ipv6 = result),
    );
    try {
      await withDeadline(Promise.all([ipv4Lookup, ipv6Lookup]), dnsDeadlineAt);
    } catch {
      cancelResolver();
    }

    const addresses: DnsAddress[] = [];
    let lookupError: unknown;
    for (const [result, addressFamily] of [
      [ipv4, 4],
      [ipv6, 6],
    ] as const) {
      if (result?.status === 'fulfilled') {
        addresses.push(
          ...result.value.map((address) => ({
            address,
            family: addressFamily,
          })),
        );
      } else if (
        result?.status === 'rejected' &&
        !isNoDnsRecord(result.reason)
      ) {
        lookupError ??= result.reason;
      }
    }
    if (addresses.length === 0 && lookupError !== undefined) {
      throw lookupError;
    }
    return addresses;
  } catch (error) {
    cancelResolver();
    throw error;
  }
}

export async function assertSafeHost(
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
    throw unsafeJwksUrl();
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

export function pinnedLookup(addresses: readonly DnsAddress[]): LookupFunction {
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
