import { CryptoVerificationToken } from './crypto-verification-token';

describe('CryptoVerificationToken', () => {
  it('issues an opaque expiring token and persists only its SHA-256 hash', () => {
    const now = new Date('2026-09-19T00:00:00.000Z');
    const issuer = new CryptoVerificationToken();
    const issued = issuer.issue(now);

    expect(issued.id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(issued.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.hash).toBe(issuer.hash(issued.raw));
    expect(issued.expiresAt).toEqual(new Date('2026-09-20T00:00:00.000Z'));
    expect(issued.hash).not.toContain(issued.raw);
  });
});
