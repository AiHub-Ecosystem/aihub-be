import { AppError } from '@/common/errors/app-error';
import type { EmailOutboxWalSlotHealth } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import {
  type AuthSqlClient,
  authQueryRows,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import { oneOf } from '@/modules/auth/shared/infrastructure/auth-row';

export async function readEmailOutboxWalSlotHealth(
  client: AuthSqlClient,
  slotName: string,
): Promise<EmailOutboxWalSlotHealth | null> {
  const rows = await authQueryRows<{
    active: boolean;
    retained_bytes: string | number;
    safe_bytes: string | number | null;
    status: string;
  }>(
    client,
    `SELECT active,
            pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes,
            safe_wal_size AS safe_bytes,
            wal_status AS status
     FROM pg_replication_slots
     WHERE slot_name = $1 AND slot_type = 'logical'`,
    [slotName],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const retainedBytes = Number(row.retained_bytes);
  const safeBytes = row.safe_bytes === null ? null : Number(row.safe_bytes);
  if (
    !Number.isFinite(retainedBytes) ||
    (safeBytes !== null && !Number.isFinite(safeBytes))
  ) {
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Email logical replication slot health is invalid',
      retryable: true,
    });
  }
  const status = oneOf({ status: row.status }, 'status', [
    'reserved',
    'extended',
    'unreserved',
    'lost',
  ]);
  if (status === undefined) {
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Email logical replication slot status is invalid',
      retryable: true,
    });
  }
  return { active: row.active, retainedBytes, safeBytes, status };
}
