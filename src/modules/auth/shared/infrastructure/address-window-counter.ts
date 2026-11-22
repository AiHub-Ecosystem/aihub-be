import { createHmac, hkdfSync } from 'node:crypto';

import { internalError } from '@/common/errors/app-error';
import { asDateOrIso } from '@/common/postgres/row-readers';

import {
  type AuthSqlClient,
  authQueryRows,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import type { EmailOutboxRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';

/**
 * Two durable counters are keyed by the normalized email address rather than by
 * the caller: the authentication-email recipient ceiling (ADR-0096) and the
 * registration attempt count (ADR-0178). Both keep the address only as a
 * versioned, domain-separated HMAC from the retained Email Outbox keyring, in a
 * fixed 24-hour window.
 *
 * The fingerprint and the retention rules live here, once, because a key
 * version that is dropped from the keyring makes both counters fail open in the
 * same way, and the boot gate has to see either table's live windows.
 */

export interface AuthAddressFingerprint {
  readonly keyVersion: string;
  readonly addressHmac: string;
}

/** The purpose that separates one counter's fingerprints from another's. */
export interface AddressFingerprintPurpose {
  readonly salt: string;
  readonly infoPrefix: string;
}

export const AUTH_EMAIL_RECIPIENT_PURPOSE: AddressFingerprintPurpose = {
  salt: 'aihub-auth-email-recipient-rate-limit-v1',
  infoPrefix: 'recipient-address',
};

export const REGISTRATION_ATTEMPT_PURPOSE: AddressFingerprintPurpose = {
  salt: 'aihub-auth-registration-attempt-count-v1',
  infoPrefix: 'registration-address',
};

/** Every table whose rows a dropped key version would make invisible. */
const ADDRESS_COUNTER_TABLES = [
  'auth_email_recipient_rate_limits',
  'auth_registration_attempt_counters',
] as const;

export const ADDRESS_COUNTER_WINDOW_MS = 24 * 60 * 60 * 1000;

export function fingerprintAddresses(
  address: string,
  secrets: EmailOutboxRuntimeSecrets | undefined,
  purpose: AddressFingerprintPurpose,
): readonly AuthAddressFingerprint[] {
  if (secrets === undefined) {
    throw internalError(
      'authentication address counter keyring is unavailable',
    );
  }
  return Object.entries(secrets.keys)
    .map(([keyVersion, encodedKey]) => {
      const masterKey = Buffer.from(encodedKey, 'base64');
      if (masterKey.length !== 32) {
        throw internalError('authentication address counter key is invalid');
      }
      const key = Buffer.from(
        hkdfSync(
          'sha256',
          masterKey,
          purpose.salt,
          `${purpose.infoPrefix}:${keyVersion}`,
          32,
        ),
      );
      return {
        keyVersion,
        addressHmac: createHmac('sha256', key)
          .update(address, 'utf8')
          .digest('hex'),
      };
    })
    .sort((left, right) =>
      `${left.keyVersion}:${left.addressHmac}`.localeCompare(
        `${right.keyVersion}:${right.addressHmac}`,
      ),
    );
}

/** The fingerprint of the key version new windows are written under. */
/**
 * A keyring that dropped a version its counters still depend on (#1130).
 * Pruning such a version makes its windows invisible to every reservation
 * written under it, which resets them: for the recipient ceiling that is the
 * one consumer where early key removal fails open.
 */
export class RetiredKeyVersionLiveError extends Error {
  constructor(detail: string) {
    super(
      `email outbox keyring no longer retains key versions with live authentication-email recipient or registration-attempt counter windows: ${detail}. Keep every retired version in the keyring until its windows expire, or wait for the expiry before pruning (ADR-0096, #1130).`,
    );
    this.name = 'RetiredKeyVersionLiveError';
  }
}

/** A counter row whose `expires_at` could not be read as a date. */
function counterDate(value: Date | string): Date {
  const date = asDateOrIso(value);
  if (date === undefined) {
    throw internalError('authentication address counter is invalid');
  }
  return date;
}

/**
 * Boot gate for the ADR-0096 retention invariant, over every address counter.
 * Refusing to boot names the versions, so an operator sees it instead of
 * discovering later that a counter silently restarted.
 */
export async function assertRetainedKeyVersionsCoverLiveWindows(
  client: AuthSqlClient,
  secrets: EmailOutboxRuntimeSecrets | undefined,
  now: Date,
): Promise<void> {
  const retired: { keyVersion: string; expiresAt: Date }[] = [];
  for (const table of ADDRESS_COUNTER_TABLES) {
    const rows = await authQueryRows<{
      readonly key_version: string;
      readonly expires_at: Date | string;
    }>(
      client,
      `SELECT key_version, max(expires_at) AS expires_at
       FROM ${table}
       WHERE expires_at > $1
       GROUP BY key_version`,
      [now],
    );
    retired.push(
      ...rows.map((row) => ({
        keyVersion: row.key_version,
        expiresAt: counterDate(row.expires_at),
      })),
    );
  }
  const retained = new Set(Object.keys(secrets?.keys ?? {}));
  const live = retired.filter(({ keyVersion }) => !retained.has(keyVersion));
  if (live.length > 0) {
    throw new RetiredKeyVersionLiveError(
      live
        .map(
          ({ keyVersion, expiresAt }) =>
            `${keyVersion} (windows live until ${expiresAt.toISOString()})`,
        )
        .join(', '),
    );
  }
}

/** Deletes every expired window of both counters, so a window can restart. */
export async function pruneExpiredAddressCounterWindows(
  client: AuthSqlClient,
  now: Date,
): Promise<number> {
  let pruned = 0;
  for (const table of ADDRESS_COUNTER_TABLES) {
    const rows = await authQueryRows<{ readonly key_version: string }>(
      client,
      `DELETE FROM ${table}
       WHERE expires_at <= $1
       RETURNING key_version`,
      [now],
    );
    pruned += rows.length;
  }
  return pruned;
}
