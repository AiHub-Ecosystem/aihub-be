import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { EmailDeliveryTransactionAdapter } from '@/modules/auth/email-delivery/infrastructure/email-delivery-transaction.adapter';
import { PostgresEmailDeliveryRequestRepository } from '@/modules/auth/email-delivery/infrastructure/postgres-email-delivery-request.repository';
import { createPostgresAuthClient } from './postgres-auth.client';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from '../shared/database';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const LEASE_MS = 30_000;

let pool: Pool;
let client: ReturnType<typeof createPostgresAuthClient>;
let repository: PostgresEmailDeliveryRequestRepository;

/** A terminal request whose failure has not been reported yet. */
async function seedUnreportedFailure(): Promise<string> {
  const id = `edr_${ulid()}`;
  await client.$transaction(async (transaction) => {
    await repository.insert(
      new EmailDeliveryTransactionAdapter(transaction as never),
      {
        id,
        kind: 'verification_email',
        payloadCiphertext: 'v1.key-1.iv.tag.ciphertext',
        createdAt: NOW,
      },
    );
  });
  await pool.query(
    `UPDATE email_delivery_requests
     SET status = 'failed', payload_ciphertext = NULL, attempts = 3,
         last_attempt_at = $2, last_error_code = 'timeout', completed_at = $2
     WHERE id = $1`,
    [id, NOW],
  );
  return id;
}

function claimAt(at: Date) {
  return repository.claimUnreportedFailures(client, {
    limit: 10,
    now: at,
    leaseMs: LEASE_MS,
  });
}

async function rowOf(id: string) {
  const { rows } = await pool.query<{
    failure_reported_at: Date | null;
    failure_notify_lease_expires_at: Date | null;
  }>(
    `SELECT failure_reported_at, failure_notify_lease_expires_at
     FROM email_delivery_requests WHERE id = $1`,
    [id],
  );
  return rows[0];
}

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresAuthClient(testDatabaseUrl());
  repository = new PostgresEmailDeliveryRequestRepository();
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
  await pool.query('DELETE FROM email_delivery_requests');
});

describe('failure-report claims against PostgreSQL (#989)', () => {
  it('lets a reporter whose lease expired neither acknowledge nor release the claim that replaced it', async () => {
    const id = await seedUnreportedFailure();
    const [first] = await claimAt(NOW);
    const [second] = await claimAt(new Date(NOW.getTime() + LEASE_MS + 1_000));
    if (first === undefined || second === undefined) {
      throw new Error('both claims must return the row');
    }
    expect(second.claim.getTime()).toBeGreaterThan(first.claim.getTime());

    await expect(
      repository.markFailureReported(client, {
        id,
        claim: first.claim,
        reportedAt: NOW,
      }),
    ).rejects.toThrow('Email delivery request is not in a queued state');
    await expect(
      repository.releaseFailureNotification(client, { id, claim: first.claim }),
    ).rejects.toThrow('Email delivery request is not in a queued state');

    await expect(rowOf(id)).resolves.toEqual({
      failure_reported_at: null,
      failure_notify_lease_expires_at: second.claim,
    });

    await repository.markFailureReported(client, {
      id,
      claim: second.claim,
      reportedAt: NOW,
    });
    await expect(rowOf(id)).resolves.toEqual({
      failure_reported_at: NOW,
      failure_notify_lease_expires_at: null,
    });
  });

  it('lets the current claimant hand the row back, so it can be claimed again at once', async () => {
    const id = await seedUnreportedFailure();
    const [claim] = await claimAt(NOW);
    if (claim === undefined) throw new Error('the claim must return the row');

    await repository.releaseFailureNotification(client, {
      id,
      claim: claim.claim,
    });

    await expect(rowOf(id)).resolves.toMatchObject({
      failure_notify_lease_expires_at: null,
    });
    await expect(claimAt(NOW)).resolves.toEqual([
      expect.objectContaining({ id }),
    ]);
  });

  it('keeps a live claim from being claimed twice', async () => {
    await seedUnreportedFailure();
    await claimAt(NOW);

    await expect(
      claimAt(new Date(NOW.getTime() + LEASE_MS - 1_000)),
    ).resolves.toEqual([]);
  });
});
