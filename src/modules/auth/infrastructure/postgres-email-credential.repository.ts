import type {
  EmailCredentialActionabilityPort,
  EmailCredentialState,
  EmailDeliveryKind,
} from '@/modules/auth/application/email-delivery-request.port';

import {
  authStoreError,
  dateValue,
  isRecord,
  nullableDateValue,
} from './auth-row';
import type { EmailDeliveryQueryClient } from './postgres-email-delivery-request.repository';

/**
 * The three credential tables share one shape — a unique token hash, an expiry,
 * and a nullable durable close — so one statement per kind is the whole check.
 * `consumed_at` is that close: verification consumed or superseded, password
 * reset consumed, invitation accepted, superseded, or revoked.
 */
const CHECK_SQL: Readonly<Partial<Record<EmailDeliveryKind, string>>> = {
  verification_email: `
    SELECT expires_at, consumed_at FROM email_verification_tokens WHERE token_hash = $1
  `,
  password_reset_email: `
    SELECT expires_at, consumed_at FROM password_reset_tokens WHERE token_hash = $1
  `,
  organization_invite_email: `
    SELECT expires_at, consumed_at FROM organization_invitations WHERE token_hash = $1
  `,
};

export class PostgresEmailCredentialRepository
  implements EmailCredentialActionabilityPort
{
  constructor(private readonly client: EmailDeliveryQueryClient) {}

  /**
   * Only the hash is read back, so a dispatch decision cannot leak a raw token,
   * and nothing here logs: the answer is a bounded state, not a reason. A row
   * whose columns are not the shape the table declares is refused rather than
   * read, so a malformed projection cannot decide a dispatch as `actionable`.
   */
  async check(input: {
    readonly kind: EmailDeliveryKind;
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<EmailCredentialState> {
    const sql = CHECK_SQL[input.kind];
    if (sql === undefined) return 'missing';
    const rows = await this.client.query(sql, [input.tokenHash]);
    const row = rows[0];
    if (row === undefined) {
      return 'missing';
    }

    const expiresAt = isRecord(row) ? dateValue(row, 'expires_at') : undefined;
    const consumedAt = isRecord(row)
      ? nullableDateValue(row, 'consumed_at')
      : undefined;
    if (expiresAt === undefined || consumedAt === undefined) {
      throw authStoreError('Email credential data is invalid');
    }

    if (expiresAt.getTime() <= input.now.getTime()) {
      return 'expired';
    }
    return consumedAt === null ? 'actionable' : 'closed';
  }
}
