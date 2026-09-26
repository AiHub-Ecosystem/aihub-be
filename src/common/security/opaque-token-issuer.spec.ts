import { createHash } from 'node:crypto';

import {
  OPAQUE_TOKEN_BINDINGS,
  opaqueTokenIssuer,
} from './opaque-token-issuer';

// The three callers this factory replaced: password-reset (`prt_`, 1h),
// verification (`evt_`, 24h) and Organization invitation (`oiv_`, 24h).
// Each binding is a distinct prefix/TTL pair, so all three are exercised here
// rather than one: a factory that ignored its arguments would pass a
// single-case test and ship three broken token lifetimes.
const BINDINGS = [
  {
    name: 'password reset',
    ...OPAQUE_TOKEN_BINDINGS.passwordReset,
    now: '2026-09-20T00:00:00.000Z',
    expiresAt: '2026-09-20T01:00:00.000Z',
  },
  {
    name: 'verification',
    ...OPAQUE_TOKEN_BINDINGS.verification,
    now: '2026-09-19T00:00:00.000Z',
    expiresAt: '2026-09-20T00:00:00.000Z',
  },
  {
    name: 'organization invitation',
    ...OPAQUE_TOKEN_BINDINGS.organizationInvite,
    now: '2026-09-20T00:00:00.000Z',
    expiresAt: '2026-09-21T00:00:00.000Z',
  },
] as const;

describe('opaqueTokenIssuer', () => {
  it.each(BINDINGS)(
    'issues a $name token whose durable value is only its hash',
    ({ prefix, ttlMs, now, expiresAt }) => {
      const now_date = new Date(now);
      const issuer = opaqueTokenIssuer(prefix, ttlMs);
      const issued = issuer.issue(now_date);

      expect(issued.id).toMatch(
        new RegExp(`^${prefix}[0-9A-HJKMNP-TV-Z]{26}$`),
      );
      expect(issued.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(issued.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(issued.hash).toBe(issuer.hash(issued.raw));
      expect(issued.hash).toBe(
        createHash('sha256').update(issued.raw, 'utf8').digest('hex'),
      );
      expect(issued.expiresAt).toEqual(new Date(expiresAt));
      expect(issued.hash).not.toContain(issued.raw);
    },
  );

  it.each(BINDINGS)(
    'issues a distinct raw value every time for a $name token',
    ({ prefix, ttlMs, now }) => {
      const issuer = opaqueTokenIssuer(prefix, ttlMs);
      const first = issuer.issue(new Date(now));
      const second = issuer.issue(new Date(now));

      expect(second.raw).not.toBe(first.raw);
      expect(second.hash).not.toBe(first.hash);
    },
  );

  it.each(BINDINGS)(
    'orders $name token IDs by mint order when timestamps match',
    ({ prefix, ttlMs, now }) => {
      const issuer = opaqueTokenIssuer(prefix, ttlMs);
      const ids = Array.from(
        { length: 20 },
        () => issuer.issue(new Date(now)).id,
      );

      expect([...ids].sort()).toEqual(ids);
    },
  );

  // The monotonic sequence is per-issuer, so two bindings never share an ID
  // space even though they mint in the same millisecond.
  it('keeps ID sequences independent per issuer', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    const first = opaqueTokenIssuer(
      OPAQUE_TOKEN_BINDINGS.passwordReset.prefix,
      OPAQUE_TOKEN_BINDINGS.passwordReset.ttlMs,
    );
    const second = opaqueTokenIssuer(
      OPAQUE_TOKEN_BINDINGS.verification.prefix,
      OPAQUE_TOKEN_BINDINGS.verification.ttlMs,
    );

    expect(first.issue(now).id).not.toBe(second.issue(now).id);
  });
});
