import { internalError } from '@/common/errors/app-error';
import {
  ADDRESS_COUNTER_WINDOW_MS,
  REGISTRATION_ATTEMPT_PURPOSE,
  fingerprintAddresses,
} from '@/modules/auth/shared/infrastructure/address-window-counter';
import {
  type AuthRepositoryClient,
  authQueryRows,
  authTransaction,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import type { EmailOutboxRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';

/**
 * Counts one registration attempt for a normalized address (#1995, ADR-0178).
 *
 * It runs on the client rather than inside the registration transaction: a
 * conflict rolls that transaction back, and the conflict is exactly the attempt
 * ADR-0178 accepts and this counter exists to measure. Every retained key
 * fingerprint is locked in stable order so concurrent writes and staged key
 * rotation share one active window.
 *
 * It counts and enforces nothing. A threshold is a later decision that this
 * evidence has to justify first.
 */
export async function countRegistrationAttempt(
  client: AuthRepositoryClient,
  secrets: EmailOutboxRuntimeSecrets | undefined,
  input: { readonly email: string; readonly now: Date },
): Promise<void> {
  if (secrets === undefined) {
    throw internalError(
      'authentication address counter keyring is unavailable',
    );
  }
  const fingerprints = fingerprintAddresses(
    input.email,
    secrets,
    REGISTRATION_ATTEMPT_PURPOSE,
  );
  const currentFingerprint = fingerprints.find(
    ({ keyVersion }) => keyVersion === secrets.currentKeyId,
  );
  if (currentFingerprint === undefined) {
    throw internalError(
      'registration attempt counter key version is unavailable',
    );
  }

  await authTransaction(client, async (transaction) => {
    for (const fingerprint of fingerprints) {
      await authQueryRows(
        transaction,
        `WITH lock AS MATERIALIZED (
             SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
           )
           SELECT 1 AS locked FROM lock`,
        [
          `auth-registration-attempt:${fingerprint.keyVersion}:${fingerprint.addressHmac}`,
        ],
      );
    }

    const values: unknown[] = [input.now];
    const keyClauses = fingerprints.map(({ keyVersion, addressHmac }) => {
      values.push(keyVersion, addressHmac);
      const keyVersionParameter = values.length - 1;
      const addressParameter = values.length;
      return `(key_version = $${keyVersionParameter} AND address_hmac = $${addressParameter})`;
    });
    const active = await authQueryRows<{
      readonly key_version: string;
      readonly address_hmac: string;
      readonly expires_at: Date | string;
    }>(
      transaction,
      `SELECT key_version, address_hmac, expires_at
       FROM auth_registration_attempt_counters
       WHERE expires_at > $1 AND (${keyClauses.join(' OR ')})
       ORDER BY expires_at, key_version, address_hmac
       FOR UPDATE`,
      values,
    );

    if (active.length > 0) {
      const target = active[0];
      if (target === undefined) return;
      await authQueryRows(
        transaction,
        `UPDATE auth_registration_attempt_counters
         SET attempt_count = attempt_count + 1
         WHERE key_version = $1 AND address_hmac = $2`,
        [target.key_version, target.address_hmac],
      );
      return;
    }

    const expiresAt = new Date(input.now.getTime() + ADDRESS_COUNTER_WINDOW_MS);
    await authQueryRows(
      transaction,
      `INSERT INTO auth_registration_attempt_counters (
           key_version, address_hmac, window_started_at, expires_at, attempt_count
         ) VALUES ($1, $2, $3, $4, 1)
         ON CONFLICT (key_version, address_hmac) DO UPDATE
         SET window_started_at = EXCLUDED.window_started_at,
             expires_at = EXCLUDED.expires_at,
             attempt_count = 1`,
      [
        currentFingerprint.keyVersion,
        currentFingerprint.addressHmac,
        input.now,
        expiresAt,
      ],
    );
  });
}
