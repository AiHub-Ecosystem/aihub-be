import { createHash, randomBytes } from 'node:crypto';

import { monotonicFactory } from 'ulid';

export interface IssuedOpaqueToken {
  readonly id: string;
  readonly raw: string;
  readonly hash: string;
  readonly expiresAt: Date;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The three bindings that share this issuer shape. The `prefix` and `ttlMs`
 * here are the durable values written to Postgres, so they are named once
 * beside the issuer rather than spelled as bare literals at each call site,
 * where a TTL typo would compile silently and ship.
 */
export const OPAQUE_TOKEN_BINDINGS = {
  passwordReset: { prefix: 'prt_', ttlMs: HOUR },
  verification: { prefix: 'evt_', ttlMs: DAY },
  organizationInvite: { prefix: 'oiv_', ttlMs: DAY },
} as const;

/**
 * The one opaque-token shape every issuer in the system shares: 32 random
 * bytes, a prefixed ULID, a SHA-256 hex digest, and a fixed TTL. Callers
 * persist only `hash`; `raw` leaves the process once, in the delivery that
 * carries it to the user.
 *
 * Same-millisecond mint order is preserved within this process by the
 * monotonic factory. It does not establish order across processes.
 */
export function opaqueTokenIssuer(
  idPrefix: string,
  ttlMs: number,
): {
  issue(now: Date): IssuedOpaqueToken;
  hash(raw: string): string;
} {
  const nextId = monotonicFactory();

  return {
    issue(now: Date): IssuedOpaqueToken {
      const raw = randomBytes(32).toString('base64url');
      return {
        id: `${idPrefix}${nextId(now.getTime())}`,
        raw,
        hash: hashToken(raw),
        expiresAt: new Date(now.getTime() + ttlMs),
      };
    },
    hash: hashToken,
  };
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}
