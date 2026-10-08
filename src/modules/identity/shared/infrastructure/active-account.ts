import { isRecord, stringValue } from './identity-row';
import type { PostgresIdentityQueryClient } from './postgres-identity.client';

const ACTIVE_ACCOUNT_BY_USERNAME_SQL = `
  SELECT id
  FROM user_accounts
  WHERE username = $1
    AND status = 'active'
`;

export async function findActiveAccountId(
  transaction: PostgresIdentityQueryClient,
  username: string,
): Promise<string | undefined> {
  const rows = await transaction.query(ACTIVE_ACCOUNT_BY_USERNAME_SQL, [
    username,
  ]);
  const row = rows[0];
  return isRecord(row) ? stringValue(row, 'id') : undefined;
}
