import { AppError } from '@/common/errors/app-error';
import type { EmailOutboxCancellationSample } from '@/common/observability/metrics';
import {
  EMAIL_DELIVERY_CANCEL_REASONS,
  EMAIL_DELIVERY_KINDS,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import {
  type AuthSqlClient,
  authQueryRows,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import { isRecord, oneOf } from '@/modules/auth/shared/infrastructure/auth-row';

const CANCELLATION_TIMESTAMP_SQL = `
  SELECT kind, cancel_reason AS reason,
         EXTRACT(EPOCH FROM max(completed_at))::float8 AS timestamp_seconds
  FROM email_delivery_requests
  WHERE status = 'cancelled'
    AND kind = ANY($1::text[])
    AND cancel_reason = ANY($2::text[])
  GROUP BY kind, cancel_reason
`;

function toSample(value: unknown): EmailOutboxCancellationSample {
  const invalid = (): never => {
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Email delivery cancellation timestamp is invalid',
      retryable: false,
    });
  };
  if (!isRecord(value)) return invalid();
  const kind = oneOf(value, 'kind', EMAIL_DELIVERY_KINDS);
  const reason = oneOf(value, 'reason', EMAIL_DELIVERY_CANCEL_REASONS);
  const timestampSeconds = value.timestamp_seconds;
  if (
    kind === undefined ||
    reason === undefined ||
    typeof timestampSeconds !== 'number' ||
    !Number.isFinite(timestampSeconds)
  ) {
    return invalid();
  }
  return { kind, reason, timestampSeconds };
}

export async function readEmailOutboxCancellationTimestamps(
  client: AuthSqlClient,
): Promise<readonly EmailOutboxCancellationSample[]> {
  const rows = await authQueryRows(client, CANCELLATION_TIMESTAMP_SQL, [
    EMAIL_DELIVERY_KINDS,
    EMAIL_DELIVERY_CANCEL_REASONS,
  ]);
  return rows.map(toSample);
}
