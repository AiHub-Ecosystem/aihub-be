import { CryptoPasswordResetToken } from './crypto-password-reset-token';

describe('CryptoPasswordResetToken', () => {
  it('issues an opaque one-hour token with a hash-only durable value', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    const issuer = new CryptoPasswordResetToken();
    const issued = issuer.issue(now);

    expect(issued.id).toMatch(/^prt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(issued.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.hash).toBe(issuer.hash(issued.raw));
    expect(issued.expiresAt).toEqual(new Date('2026-09-20T01:00:00.000Z'));
    expect(issued.hash).not.toContain(issued.raw);
  });

  it('orders token IDs by mint order when timestamps match', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    const issuer = new CryptoPasswordResetToken();
    const ids = Array.from({ length: 20 }, () => issuer.issue(now).id);

    expect([...ids].sort()).toEqual(ids);
  });
});
