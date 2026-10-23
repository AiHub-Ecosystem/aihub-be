import type { PendingRegistrationRecordPort } from '@/modules/auth/accounts/application/expire-pending-registrations';
import {
  type AuthRepositoryClient,
  authQueryRows,
} from '@/modules/auth/shared/infrastructure/auth-prisma';

// One statement, so an account and its identity and tokens go together or not
// at all. `SKIP LOCKED` leaves an account a registration or a verification
// holds: it is then no longer expired, or it is the other transaction's to end.
// ponytail: a pending account referenced by a row this does not delete (a
// session, a membership) fails the statement on its foreign key, and the run
// reports it. Add those tables here if such an account ever turns up.
const DELETE_EXPIRED_PENDING_SQL = `
  WITH expired AS (
    SELECT id FROM user_accounts
    WHERE status = 'pending_verification' AND updated_at <= $1
    ORDER BY updated_at, id
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  ), removed_tokens AS (
    DELETE FROM email_verification_tokens
    WHERE user_account_id IN (SELECT id FROM expired)
  ), removed_identities AS (
    DELETE FROM auth_identities
    WHERE user_account_id IN (SELECT id FROM expired)
  )
  DELETE FROM user_accounts
  WHERE id IN (SELECT id FROM expired)
  RETURNING id
`;

export class PostgresPendingRegistrationRecords
  implements PendingRegistrationRecordPort
{
  constructor(private readonly client: AuthRepositoryClient) {}

  async deleteExpiredPending(input: {
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<number> {
    const rows = await authQueryRows(this.client, DELETE_EXPIRED_PENDING_SQL, [
      input.expiredAtOrBefore,
      input.limit,
    ]);
    return rows.length;
  }
}
