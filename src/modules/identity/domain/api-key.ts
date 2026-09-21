import { createHash, randomBytes } from 'node:crypto';

import { ulid } from 'ulid';

export const API_KEY_PREFIX = 'aihub_sk_';

/** base62 over 32 bytes of CSPRNG output, left-padded to a fixed width. */
const API_KEY_SECRET_LENGTH = 43;
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** `aihub_sk_` plus six characters: enough to recognise a key, useless to replay. */
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 6;

export interface GeneratedApiKey {
  readonly id: string;
  readonly raw: string;
  readonly hash: string;
  readonly prefix: string;
}

export function isApiKeyFormat(value: string): boolean {
  return new RegExp(
    `^${API_KEY_PREFIX}[A-Za-z0-9]{${API_KEY_SECRET_LENGTH}}$`,
  ).test(value);
}

export function hashApiKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function apiKeyDisplayPrefix(rawKey: string): string {
  return rawKey.slice(0, DISPLAY_PREFIX_LENGTH);
}

/**
 * The one definition of an AIHUB API key. Both the self-service endpoint and
 * the operator CLI generate credentials through this function, so the two
 * provisioning paths cannot drift apart in prefix, entropy, or hashing.
 */
export function generateApiKey(now: Date = new Date()): GeneratedApiKey {
  let value = BigInt(`0x${randomBytes(32).toString('hex')}`);
  let secret = '';
  while (value > 0n) {
    const character = BASE62[Number(value % 62n)];
    if (character === undefined) {
      throw new Error('API key alphabet is misconfigured');
    }
    secret = character + secret;
    value /= 62n;
  }

  const raw = `${API_KEY_PREFIX}${secret.padStart(API_KEY_SECRET_LENGTH, '0')}`;
  return {
    id: `ak_${ulid(now.getTime())}`,
    raw,
    hash: hashApiKey(raw),
    prefix: apiKeyDisplayPrefix(raw),
  };
}

/** The lifecycle AIHUB publishes for a key, wider than the durable column. */
export type ApiKeyStatus = 'active' | 'expired' | 'revoked';

/**
 * Derives the published status of a key from its durable row.
 *
 * Expiry is not stored: a key past its expiry still reads `active` in the
 * column, and authentication rejects it through a separate check. This is the
 * one place that turns the two into the single lifecycle callers see, so the
 * application and the database cannot disagree about when a key expired.
 */
export function apiKeyStatus(
  key: {
    readonly status: 'active' | 'revoked';
    readonly expiresAt: Date | null;
  },
  now: Date,
): ApiKeyStatus {
  if (key.status === 'revoked') {
    return 'revoked';
  }
  return key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime()
    ? 'expired'
    : 'active';
}
