import type {
  EmailCredentialActionabilityPort,
  EmailCredentialState,
  EmailDeliveryKind,
} from '@/modules/auth/application/email-delivery-request.port';

import type { EmailDeliveryQueryClient } from './postgres-email-delivery-request.repository';

/**
 * The three credential tables share one shape — a unique token hash, an expiry,
 * and a nullable durable close — so one statement per kind is the whole check.
 * `consumed_at` is that close: verification consumed or superseded, password
 * reset consumed, invitation accepted, superseded, or revoked.
 */
const CHECK_SQL: Readonly<Record<EmailDeliveryKind, string>> = {
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
   * and nothing here logs: the answer is a bounded state, not a reason.
   */
  async check(input: {
    readonly kind: EmailDeliveryKind;
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<EmailCredentialState> {
    const rows = await this.client.query(CHECK_SQL[input.kind], [
      input.tokenHash,
    ]);
    const row = rows[0];
    if (row === undefined) {
      return 'missing';
    }
    const expiresAt = row.expires_at as Date;
    if (expiresAt.getTime() <= input.now.getTime()) {
      return 'expired';
    }
    return row.consumed_at === null || row.consumed_at === undefined
      ? 'actionable'
      : 'closed';
  }
}
