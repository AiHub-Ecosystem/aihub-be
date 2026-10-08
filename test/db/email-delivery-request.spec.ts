import { ulid } from 'ulid';

import type { Pool } from 'pg';

import type { EmailDeliveryTransaction } from '@/modules/auth/application/email-delivery-request.port';
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

function emailDeliveryTransaction(client: object): EmailDeliveryTransaction {
  return client as unknown as EmailDeliveryTransaction;
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
  /**
   * Every transition is fenced by the claim that produced it, so a test has to
   * hold the lease the way the poller does before it can move the row.
   *
   * Claiming takes a batch and orders by `created_at, id`, so which row a limited
   * claim returns is not the row a test asked about. This claims whatever is
   * claimable and hands back the owner, which is what makes the assertion about
   * the transition rather than about claim order.
   */
  async function claimAs(_id: string, owner: string): Promise<string> {
    await repository.claim(authClient, {
      now: NOW,
      limit: 10,
      leaseMs: 60_000,
      owner,
    });
    return owner;
  }

  it('writes inside the caller transaction and rolls back with it', async () => {
    const client = createPostgresAuthClient(testDatabaseUrl());
    try {
      await expect(
        client.transaction(async (tx) => {
          await repository.insert(
            emailDeliveryTransaction(tx),
            insertInput(requestId()),
          );
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
        await repository.insert(emailDeliveryTransaction(tx), insertInput(id));
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
        await repository.insert(emailDeliveryTransaction(tx), insertInput(id));
      });

      const attemptedAt = new Date('2026-10-05T12:00:05.000Z');
      const owner = await claimAs(id, 'owner-a');
      await repository.reserveAttempt(authClient, { id, attemptedAt, owner });
      const outcome = await repository.markProviderAccepted(authClient, {
        id,
        attemptedAt,
        owner,
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

    const attemptedAt = new Date('2026-10-05T12:01:00.000Z');
    const owner = await claimAs(id, 'owner-a');
    await repository.reserveAttempt(authClient, { id, attemptedAt, owner });
    await repository.recordFailedAttempt(authClient, {
      id,
      attemptedAt,
      errorCode: 'timeout',
      owner,
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

    const owner = await claimAs(failedId, 'owner-a');
    await repository.markFailed(authClient, {
      id: failedId,
      failedAt: new Date('2026-10-05T12:05:00.000Z'),
      errorCode: 'provider_rejected',
      owner,
    });
    await repository.markCancelled(authClient, {
      id: cancelledId,
      cancelledAt: new Date('2026-10-05T12:05:00.000Z'),
      reason: 'credential_revoked',
      owner,
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
        owner,
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

    const owner = await claimAs(id, 'owner-a');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await repository.reserveAttempt(authClient, {
        id,
        attemptedAt: new Date(Date.UTC(2026, 9, 5, 12, attempt)),
        owner,
      });
    }

    await expect(
      repository.reserveAttempt(authClient, {
        id,
        attemptedAt: new Date(),
        owner,
      }),
    ).rejects.toThrow(/queued state|attempts/i);
  });
  it('keeps a deferred row out of claims until its retry time, then returns it', async () => {
    const id = requestId();
    await repository.insert(
      emailDeliveryTransaction(authClient),
      insertInput(id),
    );
    const owner = await claimAs(id, 'owner-a');
    const retryAt = new Date(NOW.getTime() + 5 * 60_000);

    await repository.releaseDeferred(authClient, { id, owner, retryAt });

    const early = await repository.claim(authClient, {
      now: new Date(retryAt.getTime() - 1),
      limit: 10,
      leaseMs: 60_000,
      owner: 'owner-b',
    });
    expect(early.map((row) => row.id)).toEqual([]);

    const due = await repository.claim(authClient, {
      now: retryAt,
      limit: 10,
      leaseMs: 60_000,
      owner: 'owner-b',
    });
    expect(due.map((row) => row.id)).toEqual([id]);
    const { rows } = await pool.query(
      'SELECT attempts, payload_ciphertext FROM email_delivery_requests WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ attempts: 0, payload_ciphertext: CIPHERTEXT });
  });

  it('cancels and erases stale queued rows without touching fresh or leased ones', async () => {
    const stale = requestId();
    const leased = requestId();
    const fresh = requestId();
    const cutoff = new Date(NOW.getTime() - 24 * 60 * 60_000);
    const old = new Date(cutoff.getTime() - 1);
    for (const id of [stale, leased]) {
      await repository.insert(emailDeliveryTransaction(authClient), {
        ...insertInput(id),
        createdAt: old,
      });
    }
    await repository.insert(
      emailDeliveryTransaction(authClient),
      insertInput(fresh),
    );
    await pool.query(
      "UPDATE email_delivery_requests SET lease_owner = 'owner-a', lease_expires_at = $2 WHERE id = $1",
      [leased, new Date(NOW.getTime() + 60_000)],
    );

    const cancelled = await repository.cancelStale(authClient, {
      at: NOW,
      createdAtOrBefore: cutoff,
    });

    expect(cancelled.map((row) => row.id)).toEqual([stale]);
    const { rows } = await pool.query(
      'SELECT id, status, cancel_reason, payload_ciphertext FROM email_delivery_requests ORDER BY id',
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          id: stale,
          status: 'cancelled',
          cancel_reason: 'credential_expired',
          payload_ciphertext: null,
        },
        {
          id: leased,
          status: 'queued',
          cancel_reason: null,
          payload_ciphertext: CIPHERTEXT,
        },
        {
          id: fresh,
          status: 'queued',
          cancel_reason: null,
          payload_ciphertext: CIPHERTEXT,
        },
      ]),
    );
  });

  it('reports the queued backlog per kind with the age of the oldest request', async () => {
    const older = requestId();
    const newer = requestId();
    const invite = requestId();
    const done = requestId();
    await repository.insert(emailDeliveryTransaction(authClient), {
      ...insertInput(older),
      createdAt: new Date(NOW.getTime() - 600_000),
    });
    await repository.insert(emailDeliveryTransaction(authClient), {
      ...insertInput(newer),
      createdAt: new Date(NOW.getTime() - 60_000),
    });
    await repository.insert(emailDeliveryTransaction(authClient), {
      ...insertInput(invite),
      kind: 'organization_invite_email',
      createdAt: new Date(NOW.getTime() - 30_000),
    });
    await repository.insert(emailDeliveryTransaction(authClient), {
      ...insertInput(done),
      createdAt: new Date(NOW.getTime() - 3_600_000),
    });
    // A terminal row is not waiting, however old it is.
    await repository.cancelStale(authClient, {
      at: NOW,
      createdAtOrBefore: new Date(NOW.getTime() - 3_000_000),
    });

    const backlog = await repository.backlog(authClient, { now: NOW });

    expect([...backlog].sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: 'organization_invite_email', queued: 1, oldestAgeSeconds: 30 },
      { kind: 'verification_email', queued: 2, oldestAgeSeconds: 600 },
    ]);
  });

  it('reports an empty backlog as no rows', async () => {
    await expect(repository.backlog(authClient, { now: NOW })).resolves.toEqual(
      [],
    );
  });
});
