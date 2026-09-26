import { CryptoRefreshToken } from './crypto-refresh-token';

describe('CryptoRefreshToken', () => {
  it('issues an opaque 30-day token version with a family id and hash', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    const issuer = new CryptoRefreshToken();
    const issued = issuer.issue(now);

    expect(issued.id).toMatch(/^rft_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(issued.familyId).toMatch(/^rfs_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(issued.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.hash).toBe(issuer.hash(issued.raw));
    expect(issued.expiresAt).toEqual(new Date('2026-10-20T00:00:00.000Z'));
  });

  it('keeps a rotated token in the existing family', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    const issuer = new CryptoRefreshToken();
    const initial = issuer.issue(now);
    const successor = issuer.issue(now, initial.familyId);

    expect(successor.familyId).toBe(initial.familyId);
    expect(successor.id).not.toBe(initial.id);
    expect(successor.raw).not.toBe(initial.raw);
  });

  it('orders family IDs by mint order when timestamps match', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    const issuer = new CryptoRefreshToken();
    const familyIds = Array.from(
      { length: 20 },
      () => issuer.issue(now).familyId,
    );

    expect([...familyIds].sort()).toEqual(familyIds);
  });

  it('orders token IDs by mint order when timestamps match', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    const issuer = new CryptoRefreshToken();
    const familyId = issuer.issue(now).familyId;
    const tokenIds = Array.from(
      { length: 20 },
      () => issuer.issue(now, familyId).id,
    );

    expect([...tokenIds].sort()).toEqual(tokenIds);
  });
});
