import { createHmac, hkdfSync } from 'node:crypto';
import { asDateOrIso } from '@/common/postgres/row-readers';

import {
  type AuthSqlClient,
  authQueryRows,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import type { EmailOutboxRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';

/**
 * The per-recipient budget for authentication email (registration, verification
 * resend, password reset): at most nine messages to one address in a rolling day.
 * The address is kept only as an HMAC per key version, so a key rotation keeps
 * counting the same recipient without storing it.
 */
const AUTH_EMAIL_RECIPIENT_LIMIT = 9;
const AUTH_EMAIL_RECIPIENT_WINDOW_MS = 24 * 60 * 60 * 1000;

interface AuthEmailRecipientFingerprint {
  readonly keyVersion: string;
  readonly addressHmac: string;
}

interface AuthEmailRecipientLimitRow {
  readonly key_version: string;
  readonly address_hmac: string;
  readonly window_started_at: Date | string;
  readonly expires_at: Date | string;
  readonly request_count: number;
}

function fingerprintEmailRecipients(
  email: string,
  secrets: EmailOutboxRuntimeSecrets | undefined,
): readonly AuthEmailRecipientFingerprint[] {
  if (secrets === undefined) {
    throw new Error('authentication email recipient keyring is unavailable');
  }
  return Object.entries(secrets.keys)
    .map(([keyVersion, encodedKey]) => {
      const masterKey = Buffer.from(encodedKey, 'base64');
      if (masterKey.length !== 32) {
        throw new Error('authentication email recipient key is invalid');
      }
      const key = Buffer.from(
        hkdfSync(
          'sha256',
          masterKey,
          'aihub-auth-email-recipient-rate-limit-v1',
          `recipient-address:${keyVersion}`,
          32,
        ),
      );
      return {
        keyVersion,
        addressHmac: createHmac('sha256', key)
          .update(email, 'utf8')
          .digest('hex'),
      };
    })
    .sort((left, right) =>
      `${left.keyVersion}:${left.addressHmac}`.localeCompare(
        `${right.keyVersion}:${right.addressHmac}`,
      ),
    );
}

function counterDate(value: Date | string): Date {
  const date = asDateOrIso(value);
  if (date === undefined) {
    throw new Error('authentication email recipient counter is invalid');
  }
  return date;
}

export async function pruneExpiredAuthEmailRecipientLimits(
  client: AuthSqlClient,
  now: Date,
): Promise<number> {
  const rows = await authQueryRows<{ readonly key_version: string }>(
    client,
    `DELETE FROM auth_email_recipient_rate_limits
     WHERE expires_at <= $1
     RETURNING key_version`,
    [now],
  );
  return rows.length;
}

/** A keyring that dropped a version its counters still depend on (#1130). */
export class RetiredKeyVersionLiveError extends Error {
  constructor(detail: string) {
    super(
      `email outbox keyring no longer retains key versions with live authentication-email recipient windows: ${detail}. Keep every retired version in the keyring until its windows expire, or wait for the expiry before pruning (ADR-0096, #1130).`,
    );
    this.name = 'RetiredKeyVersionLiveError';
  }
}

/**
 * Boot gate for the ADR-0096 retention invariant: every counter window still
 * inside its 24 hours must fingerprint under a key version the keyring still
 * retains. Pruning a version whose windows are live makes them invisible to
 * the reservation — every address under the pruned version gets a fresh
 * window and the ceiling resets, the one consumer where early key removal
 * fails open (#1130). Refusing to boot with the versions named turns that
 * into a refusal the operator sees. A table that cannot be read is not a
 * verdict: the caller decides how to defer that case.
 */
export async function assertRetainedKeyVersionsCoverLiveWindows(
  client: AuthSqlClient,
  secrets: EmailOutboxRuntimeSecrets | undefined,
  now: Date,
): Promise<void> {
  const rows = await authQueryRows<{
    readonly key_version: string;
    readonly expires_at: Date | string;
  }>(
    client,
    `SELECT key_version, max(expires_at) AS expires_at
     FROM auth_email_recipient_rate_limits
     WHERE expires_at > $1
     GROUP BY key_version`,
    [now],
  );
  const retained = new Set(Object.keys(secrets?.keys ?? {}));
  const retired = rows.filter((row) => !retained.has(row.key_version));
  if (retired.length > 0) {
    const detail = retired
      .map(
        (row) =>
          `${row.key_version} (windows live until ${counterDate(row.expires_at).toISOString()})`,
      )
      .join(', ');
    throw new RetiredKeyVersionLiveError(detail);
  }
}

/**
 * Takes one of the recipient's slots inside the caller's transaction, and says
 * whether the email may be queued. Concurrent requests for one address
 * serialize on an advisory lock per fingerprint.
 */
export async function reserveAuthenticationEmailRecipient(
  client: AuthSqlClient,
  secrets: EmailOutboxRuntimeSecrets | undefined,
  input: { readonly email: string; readonly now: Date },
): Promise<boolean> {
  const fingerprints = fingerprintEmailRecipients(input.email, secrets);
  for (const fingerprint of fingerprints) {
    await authQueryRows(
      client,
      `WITH lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
         )
         SELECT 1 AS locked FROM lock`,
      [
        `auth-email-recipient:${fingerprint.keyVersion}:${fingerprint.addressHmac}`,
      ],
    );
  }

  const active: AuthEmailRecipientLimitRow[] = [];
  for (const fingerprint of fingerprints) {
    const rows = await authQueryRows<AuthEmailRecipientLimitRow>(
      client,
      `SELECT key_version, address_hmac, window_started_at, expires_at,
                request_count
         FROM auth_email_recipient_rate_limits
         WHERE key_version = $1 AND address_hmac = $2 AND expires_at > $3
         FOR UPDATE`,
      [fingerprint.keyVersion, fingerprint.addressHmac, input.now],
    );
    active.push(...rows);
  }

  const requestCount = Math.max(
    0,
    ...active.map((row) => {
      if (!Number.isInteger(row.request_count) || row.request_count < 1) {
        throw new Error('authentication email recipient counter is invalid');
      }
      return row.request_count;
    }),
  );
  const currentFingerprint = fingerprints.find(
    ({ keyVersion }) => keyVersion === secrets?.currentKeyId,
  );
  if (currentFingerprint === undefined) {
    throw new Error(
      'authentication email recipient key version is unavailable',
    );
  }
  const existingCounter = active
    .slice()
    .sort(
      (left, right) =>
        counterDate(left.expires_at).getTime() -
        counterDate(right.expires_at).getTime(),
    )[0];
  const writeFingerprint =
    existingCounter === undefined
      ? currentFingerprint
      : fingerprints.find(
          ({ keyVersion, addressHmac }) =>
            keyVersion === existingCounter.key_version &&
            addressHmac === existingCounter.address_hmac,
        );
  if (writeFingerprint === undefined) {
    throw new Error(
      'authentication email recipient counter key is unavailable',
    );
  }
  const windowStartedAt =
    active.length === 0
      ? input.now
      : active
          .map((row) => counterDate(row.window_started_at))
          .reduce((earliest, value) => (value < earliest ? value : earliest));
  const expiresAt =
    active.length === 0
      ? new Date(input.now.getTime() + AUTH_EMAIL_RECIPIENT_WINDOW_MS)
      : active
          .map((row) => counterDate(row.expires_at))
          .reduce((earliest, value) => (value < earliest ? value : earliest));
  const nextCount = Math.min(
    AUTH_EMAIL_RECIPIENT_LIMIT,
    requestCount + (requestCount < AUTH_EMAIL_RECIPIENT_LIMIT ? 1 : 0),
  );

  await authQueryRows(
    client,
    `INSERT INTO auth_email_recipient_rate_limits (
         key_version, address_hmac, window_started_at, expires_at, request_count
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key_version, address_hmac) DO UPDATE
       SET window_started_at = EXCLUDED.window_started_at,
           expires_at = EXCLUDED.expires_at,
           request_count = EXCLUDED.request_count`,
    [
      writeFingerprint.keyVersion,
      writeFingerprint.addressHmac,
      windowStartedAt,
      expiresAt,
      nextCount,
    ],
  );
  return requestCount < AUTH_EMAIL_RECIPIENT_LIMIT;
}
