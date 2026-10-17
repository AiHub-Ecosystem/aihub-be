import type {
  EmailCredentialActionabilityPort,
  EmailCredentialState,
  EmailDeliveryKind,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';

import type { AuthSqlClient } from '@/modules/auth/shared/infrastructure/auth-prisma';
import { authStoreError } from '@/modules/auth/shared/infrastructure/auth-row';

/** The two columns of a credential row that decide whether it can be acted on. */
interface CredentialState {
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

const CREDENTIAL = { expiresAt: true, consumedAt: true } as const;

export class PostgresEmailCredentialRepository
  implements EmailCredentialActionabilityPort
{
  constructor(private readonly client: AuthSqlClient) {}

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
    const row = await this.credential(input.kind, input.tokenHash);
    if (row === null) {
      return 'missing';
    }

    const { expiresAt, consumedAt } = row;
    // The generated client types both columns, but a row the table could not
    // have produced is refused rather than decided on.
    if (
      !(expiresAt instanceof Date) ||
      Number.isNaN(expiresAt.getTime()) ||
      (consumedAt !== null &&
        (!(consumedAt instanceof Date) || Number.isNaN(consumedAt.getTime())))
    ) {
      throw authStoreError('Email credential data is invalid');
    }

    if (expiresAt.getTime() <= input.now.getTime()) {
      return 'expired';
    }
    return consumedAt === null ? 'actionable' : 'closed';
  }

  /**
   * The three credential tables share one shape: a unique token hash, an
   * expiry, and a nullable durable close. `consumedAt` is that close:
   * verification consumed or superseded, password reset consumed, invitation
   * accepted, superseded, or revoked. A kind with no credential has none.
   */
  private credential(
    kind: EmailDeliveryKind,
    tokenHash: string,
  ): Promise<CredentialState | null> {
    const where = { tokenHash };
    switch (kind) {
      case 'verification_email':
        return this.client.emailVerificationToken.findUnique({
          where,
          select: CREDENTIAL,
        });
      case 'password_reset_email':
        return this.client.passwordResetToken.findUnique({
          where,
          select: CREDENTIAL,
        });
      case 'organization_invite_email':
        return this.client.organizationInvitation.findUnique({
          where,
          select: CREDENTIAL,
        });
      default:
        return Promise.resolve(null);
    }
  }
}
