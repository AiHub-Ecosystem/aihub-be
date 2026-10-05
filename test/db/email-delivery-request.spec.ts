import { ulid } from 'ulid';

import type { Pool } from 'pg';

import { createPostgresAuthClient } from '@/modules/auth/infrastructure/postgres-auth.client';
import { PostgresEmailDeliveryRequestRepository } from '@/modules/auth/infrastructure/postgres-email-delivery-request.repository';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from './database';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const CIPHERTEXT = 'v1.key-1.iv.tag.ciphertext';

let pool: Pool;
let authClient: ReturnType<typeof createPostgresAuthClient>;
let repository: PostgresEmailDeliveryRequestRepository;

function requestId(): string {
  return `edr_${ulid()}`;
}

function insertInput(id: string) {
  return {
    id,
    kind: 'verification_email' as const,
    payloadCiphertext: CIPHERTEXT,
    createdAt: NOW,
  };
}

beforeAll(() => {
  pool = createTestPool();
  authClient = createPostgresAuthClient(testDatabaseUrl());
});

afterAll(async () => {
  await pool.end();
  await authClient.close();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
  repository = new PostgresEmailDeliveryRequestRepository();
});

describe('email delivery request repository', () => {
  it('writes inside the caller transaction and rolls back with it', async () => {
    const client = createPostgresAuthClient(testDatabaseUrl());
    try {
      await expect(
        client.transaction(async (tx) => {
          await repository.insert(tx, insertInput(requestId()));
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      const rows = await pool.query('SELECT id FROM email_delivery_requests');
      expect(rows.rowCount).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('commits the row with its inserting transaction', async () => {
    const client = createPostgresAuthClient(testDatabaseUrl());
    try {
      const id = requestId();
      await client.transaction(async (tx) => {
        await repository.insert(tx, insertInput(id));
      });

      const rows = await pool.query(
        'SELECT status, payload_ciphertext, attempts FROM email_delivery_requests WHERE id = $1',
        [id],
      );
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0]).toMatchObject({
        status: 'queued',
        payload_ciphertext: CIPHERTEXT,
        attempts: 0,
      });
    } finally {
      await client.close();
    }
  });

  it('moves queued -> provider_accepted, erases ciphertext, keeps evidence', async () => {
    const client = createPostgresAuthClient(testDatabaseUrl());
    try {
      const id = requestId();
      await client.transaction(async (tx) => {
        await repository.insert(tx, insertInput(id));
      });

      const attemptedAt = new Date('2026-10-05T12:00:05.000Z');
      const outcome = await repository.markProviderAccepted(authClient, {
        id,
        attemptedAt,
      });

      expect(outcome).toMatchObject({
        id,
        status: 'provider_accepted',
        attempts: 1,
        payloadCiphertext: null,
      });

      const rows = await pool.query(
        'SELECT status, payload_ciphertext, attempts, last_attempt_at, completed_at FROM email_delivery_requests WHERE id = $1',
        [id],
      );
      expect(rows.rows[0]).toMatchObject({
        status: 'provider_accepted',
        payload_ciphertext: null,
        attempts: 1,
      });
      expect(rows.rows[0].last_attempt_at).not.toBeNull();
      expect(rows.rows[0].completed_at).not.toBeNull();
    } finally {
      await client.close();
    }
  });

  it('records bounded attempt evidence while staying queued', async () => {
    const id = requestId();
    await pool.query(
      "INSERT INTO email_delivery_requests (id, kind, status, payload_ciphertext, created_at) VALUES ($1, 'verification_email', 'queued', $2, $3)",
      [id, CIPHERTEXT, NOW],
    );

    await repository.recordFailedAttempt(authClient, {
      id,
      attemptedAt: new Date('2026-10-05T12:01:00.000Z'),
      errorCode: 'timeout',
    });
    const rows = await pool.query(
      'SELECT status, attempts, last_error_code, payload_ciphertext FROM email_delivery_requests WHERE id = $1',
      [id],
    );
    expect(rows.rows[0]).toMatchObject({
      status: 'queued',
      attempts: 1,
      last_error_code: 'timeout',
      payload_ciphertext: CIPHERTEXT,
    });
  });

  it('erases ciphertext at failed and cancelled without reviving', async () => {
    const failedId = requestId();
    const cancelledId = requestId();
    for (const id of [failedId, cancelledId]) {
      await pool.query(
        "INSERT INTO email_delivery_requests (id, kind, status, payload_ciphertext, created_at) VALUES ($1, 'password_reset_email', 'queued', $2, $3)",
        [id, CIPHERTEXT, NOW],
      );
    }

    await repository.markFailed(authClient, {
      id: failedId,
      failedAt: new Date('2026-10-05T12:05:00.000Z'),
      errorCode: 'provider_rejected',
    });
    await repository.markCancelled(authClient, {
      id: cancelledId,
      cancelledAt: new Date('2026-10-05T12:05:00.000Z'),
      reason: 'credential_revoked',
    });

    const rows = await pool.query(
      'SELECT id, status, payload_ciphertext, cancel_reason, completed_at FROM email_delivery_requests ORDER BY id',
    );
    for (const row of rows.rows) {
      expect(row.payload_ciphertext).toBeNull();
      expect(row.completed_at).not.toBeNull();
    }
    expect(rows.rows.find((row) => row.id === cancelledId)?.cancel_reason).toBe(
      'credential_revoked',
    );

    await expect(
      repository.markCancelled(authClient, {
        id: failedId,
        cancelledAt: new Date(),
        reason: 'not_actionable',
      }),
    ).rejects.toThrow(/queued state|attempts/i);

    const after = await pool.query(
      'SELECT status, payload_ciphertext FROM email_delivery_requests WHERE id = $1',
      [failedId],
    );
    expect(after.rows[0]).toMatchObject({
      status: 'failed',
      payload_ciphertext: null,
    });
  });

  it('bounds attempts at three', async () => {
    const id = requestId();
    await pool.query(
      "INSERT INTO email_delivery_requests (id, kind, status, payload_ciphertext, created_at) VALUES ($1, 'organization_invite_email', 'queued', $2, $3)",
      [id, CIPHERTEXT, NOW],
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await repository.recordFailedAttempt(authClient, {
        id,
        attemptedAt: new Date(Date.UTC(2026, 9, 5, 12, attempt)),
        errorCode: 'timeout',
      });
    }

    await expect(
      repository.recordFailedAttempt(authClient, {
        id,
        attemptedAt: new Date(),
        errorCode: 'timeout',
      }),
    ).rejects.toThrow(/queued state|attempts/i);
  });
});
