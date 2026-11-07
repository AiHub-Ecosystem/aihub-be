import { unsafeJwksUrl } from '@/modules/identity/shared/application/jwks-errors';

import { assertSafeHost, defaultJwksResolverFactory } from './jwks-host-safety';

/**
 * The unsafe-address decision is pinned at the public seam: a literal host
 * skips DNS entirely, so `assertSafeHost` observes the address check alone.
 * Every case is a boundary or a notation edge a hand-written parser tends to
 * miss (zone ids, compressed and uncompressed forms, IPv4-mapped in both
 * notations, and the address on each side of every range).
 *
 * Expected values come from the range table itself (independent literals),
 * not from re-running the implementation.
 */

const resolverFactory = defaultJwksResolverFactory;

async function resolvesSafe(address: string): Promise<boolean> {
  try {
    const addresses = await assertSafeHost(
      address,
      resolverFactory,
      Date.now() + 5_000,
    );
    return (
      addresses.length === 1 &&
      addresses[0]?.address === address.replace(/^\[|\]$/g, '')
    );
  } catch {
    return false;
  }
}

describe('assertSafeHost address check (#419)', () => {
  describe('rejects the boundary address of every unsafe IPv4 range', () => {
    it.each([
      ['0.0.0.0'],
      ['0.255.255.255'],
      ['10.0.0.0'],
      ['10.255.255.255'],
      ['100.64.0.0'],
      ['100.127.255.255'],
      ['127.0.0.0'],
      ['127.255.255.255'],
      ['169.254.0.0'],
      ['169.254.255.255'],
      ['172.16.0.0'],
      ['172.31.255.255'],
      ['192.0.0.0'],
      ['192.0.0.255'],
      ['192.0.2.0'],
      ['192.0.2.255'],
      ['192.88.99.0'],
      ['192.88.99.255'],
      ['192.168.0.0'],
      ['192.168.255.255'],
      ['198.18.0.0'],
      ['198.19.255.255'],
      ['198.51.100.0'],
      ['198.51.100.255'],
      ['203.0.113.0'],
      ['203.0.113.255'],
      ['224.0.0.0'],
      ['239.255.255.255'],
      ['240.0.0.0'],
      ['255.255.255.255'],
    ])('rejects %s', async (address) => {
      await expect(
        assertSafeHost(address, resolverFactory, Date.now() + 5_000),
      ).rejects.toMatchObject(unsafeJwksUrl());
    });
  });

  describe('accepts the address just outside every unsafe IPv4 range', () => {
    it.each([
      ['1.0.0.0'],
      ['9.255.255.255'],
      ['11.0.0.0'],
      ['100.63.255.255'],
      ['100.128.0.0'],
      ['126.255.255.255'],
      ['128.0.0.0'],
      ['169.253.255.255'],
      ['169.255.0.0'],
      ['172.15.255.255'],
      ['172.32.0.0'],
      ['192.0.1.0'],
      ['192.0.3.0'],
      ['192.88.98.255'],
      ['192.88.100.0'],
      ['192.169.0.0'],
      ['198.17.255.255'],
      ['198.20.0.0'],
      ['198.51.99.255'],
      ['198.51.101.0'],
      ['203.0.112.255'],
      ['203.0.114.0'],
      ['223.255.255.255'],
      ['8.8.8.8'],
      ['1.1.1.1'],
    ])('accepts %s', async (address) => {
      await expect(resolvesSafe(address)).resolves.toBe(true);
    });
  });

  describe('keeps the IPv6 allowlist decision', () => {
    it.each([
      ['::'],
      ['::1'],
      ['::ffff:127.0.0.1'],
      ['::ffff:8.8.8.8'],
      ['0:0:0:0:0:ffff:a00:1'],
      ['64:ff9b:1::a00:1'],
      ['64:ff9b::a00:1'],
      ['100::1'],
      ['5f00::1'],
      ['fc00::1'],
      ['fd00::1'],
      ['fe80::1'],
      ['ff02::1'],
      ['2001::1'],
      ['2001:1ff::1'],
      ['2001:db8::1'],
      ['2002:c000:0201::1'],
      ['3fff::1'],
      ['3fff:fff::1'],
      ['4000::1'],
    ])('rejects %s', async (address) => {
      await expect(
        assertSafeHost(address, resolverFactory, Date.now() + 5_000),
      ).rejects.toMatchObject(unsafeJwksUrl());
    });

    it.each([
      ['2000::'],
      ['3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
      ['2001:db7::1'],
      ['2001:db9::1'],
      ['2001:0200:0000:0000:0000:0000:0000:0001'],
      ['2001:200::2:68'],
      ['2606:4700::1111'],
      ['2606:4700::1111%eth0'],
      ['2a00:1450:4009:81f::200e'],
    ])('accepts %s', async (address) => {
      await expect(resolvesSafe(address)).resolves.toBe(true);
    });
  });

  it('rejects a non-IP host string without reaching DNS', async () => {
    const failingFactory = () => {
      throw new Error('a non-IP host must not be resolved here');
    };
    await expect(
      assertSafeHost('not-an-ip.example', failingFactory, Date.now() + 5_000),
    ).rejects.toMatchObject({ code: 'IDENTITY_JWKS_SOURCE_UNAVAILABLE' });
  });
});
