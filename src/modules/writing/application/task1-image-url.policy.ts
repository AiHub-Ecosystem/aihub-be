import { isIP } from 'node:net';

import { TASK1_IMAGE_URL_MAX_LENGTH } from '@/contracts/writing/grading';

const IPV4_NON_PUBLIC_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // this network
  [0x0a000000, 8], // private-use
  [0x64400000, 10], // shared address space
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local
  [0xac100000, 12], // private-use
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // documentation
  [0xc0586300, 24], // deprecated 6to4 relay anycast
  [0xc0a80000, 16], // private-use
  [0xc6120000, 15], // benchmarking
  [0xc6336400, 24], // documentation
  [0xcb007100, 24], // documentation
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved
];

function ipv4Value(address: string): number {
  return address
    .split('.')
    .reduce((value, octet) => value * 256 + Number(octet), 0);
}

function isNonPublicIpv4(address: string): boolean {
  const value = ipv4Value(address);
  return IPV4_NON_PUBLIC_BLOCKS.some(([network, prefix]) => {
    const divisor = 2 ** (32 - prefix);
    return Math.floor(value / divisor) === Math.floor(network / divisor);
  });
}

function ipv6Value(address: string): bigint {
  const [leftPart = '', rightPart] = address.split('::');
  const left = leftPart === '' ? [] : leftPart.split(':');
  const right =
    rightPart === undefined || rightPart === '' ? [] : rightPart.split(':');
  const zeroes = 8 - left.length - right.length;
  const groups =
    rightPart === undefined
      ? left
      : [...left, ...Array<string>(zeroes).fill('0'), ...right];

  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

const IPV6_NON_PUBLIC_BLOCKS: ReadonlyArray<readonly [bigint, number]> = [
  [ipv6Value('2001::'), 23], // IETF protocol assignments
  [ipv6Value('2001:2::'), 48], // benchmarking
  [ipv6Value('2001:db8::'), 32], // documentation
  [ipv6Value('2002::'), 16], // 6to4
  [ipv6Value('3fff::'), 20], // documentation
];

function isNonPublicIpv6(address: string): boolean {
  const value = ipv6Value(address);
  // IANA currently allocates global-unicast IPv6 addresses only from 2000::/3.
  return (
    value >> 125n !== 1n ||
    IPV6_NON_PUBLIC_BLOCKS.some(
      ([network, prefix]) =>
        value >> BigInt(128 - prefix) === network >> BigInt(128 - prefix),
    )
  );
}

// Names a resolver near the fetcher may answer with a loopback or private
// address (RFC 6761 localhost, RFC 6762 .local, RFC 8375 .home.arpa, ICANN's
// private-use .internal). A name without a dot is a search-domain lookup.
const NON_PUBLIC_NAME_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'home.arpa',
] as const;

function isNonPublicName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return (
    !name.includes('.') ||
    NON_PUBLIC_NAME_SUFFIXES.some(
      (suffix) => name === suffix || name.endsWith(`.${suffix}`),
    )
  );
}

/**
 * Checks only the submitted URL's structure. DNS destination checks stay with
 * AI Writing, which performs the image fetch.
 */
export function isAllowedTask1ImageUrl(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > TASK1_IMAGE_URL_MAX_LENGTH ||
    value.trim() !== value ||
    /\s/.test(value)
  ) {
    return false;
  }

  const authority = value.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1];
  if (authority === undefined || authority.includes('@')) {
    return false;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== ''
    ) {
      return false;
    }

    const host = url.hostname.replace(/^\[|\]$/g, '');
    const version = isIP(host);
    return (
      (version === 0 && !isNonPublicName(host)) ||
      (version === 4 && !isNonPublicIpv4(host)) ||
      (version === 6 && !isNonPublicIpv6(host))
    );
  } catch {
    return false;
  }
}
