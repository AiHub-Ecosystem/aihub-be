import { AppError } from '@/common/errors/app-error';

/**
 * Structural minimum for any client that can run a single statement: the auth
 * pool client, the identity client, and either one's transaction handle all
 * satisfy it, so a repository call can ride the caller's open transaction.
 */
export interface EmailDeliveryQueryClient {
  query(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
}

export type EmailDeliveryKind =
  | 'verification_email'
  | 'password_reset_email'
  | 'organization_invite_email';

export interface InsertEmailDeliveryRequestInput {
  id: string;
  kind: EmailDeliveryKind;
  payloadCiphertext: string;
  createdAt: Date;
}

export interface EmailDeliveryRequestRecord {
  id: string;
  kind: EmailDeliveryKind;
  status: 'queued' | 'provider_accepted' | 'failed' | 'cancelled';
  payloadCiphertext: string | null;
  attempts: number;
  lastAttemptAt: Date | null;
  lastErrorCode: string | null;
  cancelReason: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

const SELECT_ROW = `
  SELECT id, kind, status, payload_ciphertext, attempts, last_attempt_at,
         last_error_code, cancel_reason, created_at, completed_at
  FROM email_delivery_requests
  WHERE id = $1
`;

const INSERT_SQL = `
  INSERT INTO email_delivery_requests (id, kind, status, payload_ciphertext, created_at)
  VALUES ($1, $2, 'queued', $3, $4)
`;

/**
 * Each marker is one attempt, except cancellation, which happens before
 * dispatch. A marker only applies while the row is still queued, so a
 * terminal state can never be overwritten or revived.
 */
const RECORD_FAILED_ATTEMPT_SQL = `
  UPDATE email_delivery_requests
  SET attempts = attempts + 1, last_attempt_at = $2, last_error_code = $3
  WHERE id = $1 AND status = 'queued'
  RETURNING id
`;

const MARK_PROVIDER_ACCEPTED_SQL = `
  UPDATE email_delivery_requests
  SET status = 'provider_accepted', attempts = attempts + 1,
      last_attempt_at = $2, payload_ciphertext = NULL, completed_at = $2
  WHERE id = $1 AND status = 'queued'
  RETURNING id
`;

const MARK_FAILED_SQL = `
  UPDATE email_delivery_requests
  SET status = 'failed', attempts = attempts + 1, last_attempt_at = $2,
      last_error_code = $3, payload_ciphertext = NULL, completed_at = $2
  WHERE id = $1 AND status = 'queued'
  RETURNING id
`;

const MARK_CANCELLED_SQL = `
  UPDATE email_delivery_requests
  SET status = 'cancelled', cancel_reason = $2,
      payload_ciphertext = NULL, completed_at = $3
  WHERE id = $1 AND status = 'queued'
  RETURNING id
`;

function storeError(message: string): AppError {
  return new AppError({ code: 'INTERNAL_ERROR', message, retryable: false });
}

export class PostgresEmailDeliveryRequestRepository {
  async insert(
    client: EmailDeliveryQueryClient,
    input: InsertEmailDeliveryRequestInput,
  ): Promise<void> {
    await client.query(INSERT_SQL, [
      input.id,
      input.kind,
      input.payloadCiphertext,
      input.createdAt,
    ]);
  }

  async recordFailedAttempt(
    client: EmailDeliveryQueryClient,
    input: { id: string; attemptedAt: Date; errorCode: string },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, RECORD_FAILED_ATTEMPT_SQL, [
      input.id,
      input.attemptedAt,
      input.errorCode,
    ]);
  }

  async markProviderAccepted(
    client: EmailDeliveryQueryClient,
    input: { id: string; attemptedAt: Date },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, MARK_PROVIDER_ACCEPTED_SQL, [
      input.id,
      input.attemptedAt,
    ]);
  }

  async markFailed(
    client: EmailDeliveryQueryClient,
    input: { id: string; failedAt: Date; errorCode: string },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, MARK_FAILED_SQL, [
      input.id,
      input.failedAt,
      input.errorCode,
    ]);
  }

  async markCancelled(
    client: EmailDeliveryQueryClient,
    input: { id: string; cancelledAt: Date; reason: string },
  ): Promise<EmailDeliveryRequestRecord> {
    return this.apply(client, MARK_CANCELLED_SQL, [
      input.id,
      input.reason,
      input.cancelledAt,
    ]);
  }

  private async apply(
    client: EmailDeliveryQueryClient,
    sql: string,
    values: readonly unknown[],
  ): Promise<EmailDeliveryRequestRecord> {
    const updated = await client.query(sql, values);
    if (updated.length === 0) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Email delivery request is not in a queued state',
        retryable: false,
      });
    }
    const rows = await client.query(SELECT_ROW, [values[0]]);
    const row = rows[0];
    if (row === undefined) {
      throw storeError('Email delivery request is unavailable');
    }
    return this.toRecord(row);
  }

  private toRecord(row: Record<string, unknown>): EmailDeliveryRequestRecord {
    return {
      id: row.id as string,
      kind: row.kind as EmailDeliveryKind,
      status: row.status as EmailDeliveryRequestRecord['status'],
      payloadCiphertext: row.payload_ciphertext as string | null,
      attempts: Number(row.attempts),
      lastAttemptAt: (row.last_attempt_at as Date | null) ?? null,
      lastErrorCode: row.last_error_code as string | null,
      cancelReason: row.cancel_reason as string | null,
      createdAt: row.created_at as Date,
      completedAt: (row.completed_at as Date | null) ?? null,
    };
  }
}
