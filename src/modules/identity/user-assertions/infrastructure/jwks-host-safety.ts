import { Resolver } from 'node:dns/promises';
import { BlockList, type LookupFunction, isIP } from 'node:net';
import { internalError } from '@/common/errors/app-error';

import { unsafeJwksUrl } from '@/modules/identity/shared/application/jwks-errors';
import { sourceUnavailable } from './jwks-source-errors';

const JWKS_DNS_TIMEOUT_MS = 1_000;

const unsafeIpv4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  unsafeIpv4.addSubnet(network, prefix);
}

// IPv6 stays allowlist-shaped: an address is safe only inside the global
// unicast range 2000::/3, minus the excluded sub-ranges. Both sides are
// BlockList rules, so `check` answers membership and the decision is the
// conjunction below. IPv4-mapped and NAT64 addresses fall outside 2000::/3
// and are refused without their own rules.
const globalUnicastIpv6 = new BlockList();
globalUnicastIpv6.addSubnet('2000::', 3, 'ipv6');

const excludedGlobalUnicastIpv6 = new BlockList();
for (const [network, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const) {
  excludedGlobalUnicastIpv6.addSubnet(network, prefix, 'ipv6');
}

function isSafeIpv6(address: string): boolean {
  return (
    globalUnicastIpv6.check(address, 'ipv6') &&
    !excludedGlobalUnicastIpv6.check(address, 'ipv6')
  );
}

function isUnsafeAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? unsafeIpv4.check(address)
    : family === 6
      ? !isSafeIpv6(address)
      : true;
}

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
    throw internalError('JWKS lookup timed out');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(internalError('JWKS lookup timed out')),
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
        Object.assign(
          // app-error-check: allow node:dns requires the ENOTFOUND errno code.
          new Error('No public JWKS address'),
          { code: 'ENOTFOUND' },
        ),
        '',
        0,
      );
      return;
    }
    callback(null, address.address, address.family);
  };
}
