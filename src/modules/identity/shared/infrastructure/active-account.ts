import { isRecord } from '@/common/is-record';
import { stringValue } from './identity-row';
import { identityRows } from './postgres-identity.client';

const ACTIVE_ACCOUNT_BY_USERNAME_SQL = `
  SELECT id
  FROM user_accounts
  WHERE username = $1
    AND status = 'active'
`;

export async function findActiveAccountId(
  transaction: Parameters<typeof identityRows>[0],
  username: string,
): Promise<string | undefined> {
  const rows = await identityRows(transaction, ACTIVE_ACCOUNT_BY_USERNAME_SQL, [
    username,
  ]);
  const row = rows[0];
  return isRecord(row) ? stringValue(row, 'id') : undefined;
}
