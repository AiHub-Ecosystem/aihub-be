import { createHash } from 'node:crypto';

import { CryptoOrganizationInviteToken } from './crypto-organization-invite-token';

describe('CryptoOrganizationInviteToken', () => {
  it('issues an opaque 24-hour token whose durable value is only its hash', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    const issuer = new CryptoOrganizationInviteToken();
    const issued = issuer.issue(now);

    expect(issued.id).toMatch(/^oiv_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(issued.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.hash).toBe(
      createHash('sha256').update(issued.raw, 'utf8').digest('hex'),
    );
    expect(issued.expiresAt).toEqual(new Date('2026-09-21T00:00:00.000Z'));
    expect(issued.hash).not.toContain(issued.raw);
  });

  it('issues a distinct raw value every time', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    const issuer = new CryptoOrganizationInviteToken();

    const first = issuer.issue(now);
    const second = issuer.issue(now);

    expect(second.raw).not.toBe(first.raw);
    expect(second.hash).not.toBe(first.hash);
  });

  it('orders token IDs by mint order when timestamps match', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    const issuer = new CryptoOrganizationInviteToken();
    const ids = Array.from({ length: 20 }, () => issuer.issue(now).id);

    expect([...ids].sort()).toEqual(ids);
  });
});
