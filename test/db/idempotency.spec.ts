import type { Pool } from 'pg';

import type {
  CompleteIdempotencyInput,
  ReserveIdempotencyInput,
} from '../../src/modules/idempotency/application/idempotency-repository.port';
import type { PostgresIdempotencyClient } from '../../src/modules/idempotency/infrastructure/postgres-idempotency.client';
import { PostgresIdempotencyRepository } from '../../src/modules/idempotency/infrastructure/postgres-idempotency.repository';

import { createTestPool } from './database';

const ORGANIZATION_ID = 'org_acme';
const OTHER_ORGANIZATION_ID = 'org_other';
const OPERATION = 'organizations.invitations.create' as const;
const FINGERPRINT = 'a'.repeat(64);

let pool: Pool;
let repository: PostgresIdempotencyRepository;

function client(): PostgresIdempotencyClient {
  return {
    async query(text, values) {
      const result = await pool.query<Record<string, unknown>>(text, [
        ...values,
      ]);
      return result.rows;
    },
    close: async () => undefined,
  };
}

function reserveInput(
  actorScope: string,
  requestId: string,
  idempotencyKey = 'invite-1',
): ReserveIdempotencyInput {
  return {
    organizationId: ORGANIZATION_ID,
    operation: OPERATION,
    actorScope,
    idempotencyKey,
    fingerprintHex: FINGERPRINT,
    requestId,
    expiresAt: new Date('2026-09-23T00:00:00.000Z'),
  };
}

function completeInput(
  actorScope: string,
  requestId: string,
): CompleteIdempotencyInput {
  return {
    organizationId: ORGANIZATION_ID,
    operation: OPERATION,
    actorScope,
    idempotencyKey: 'invite-1',
    requestId,
    responseStatus: 201,
    responseBody: { invitationId: 'oiv_1' },
  };
}

async function seedOrganizations(): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, name, status)
     VALUES ($1, $2, 'active'), ($3, $4, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [
      ORGANIZATION_ID,
      `Organization ${ORGANIZATION_ID}`,
      OTHER_ORGANIZATION_ID,
      `Organization ${OTHER_ORGANIZATION_ID}`,
    ],
  );
}

describe('Postgres idempotency management scope', () => {
  beforeAll(async () => {
    pool = createTestPool();
    repository = new PostgresIdempotencyRepository(client());
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE idempotency_records');
    await seedOrganizations();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('installs the management composite primary key', async () => {
    const result = await pool.query<{ column_name: string }>(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema
      WHERE tc.table_name = 'idempotency_records'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `);

    expect(result.rows.map((row) => row.column_name)).toEqual([
      'organization_id',
      'operation',
      'actor_scope',
      'idempotency_key',
    ]);
  });

  it('keeps the same key independent across callers and Organizations', async () => {
    await expect(
      repository.reserve(reserveInput('usr_owner', 'req_owner')),
    ).resolves.toEqual({ kind: 'claimed', requestId: 'req_owner' });
    await expect(
      repository.reserve(reserveInput('usr_admin', 'req_admin')),
    ).resolves.toEqual({ kind: 'claimed', requestId: 'req_admin' });
    await expect(
      repository.reserve({
        ...reserveInput('usr_owner', 'req_other_org'),
        organizationId: OTHER_ORGANIZATION_ID,
      }),
    ).resolves.toEqual({ kind: 'claimed', requestId: 'req_other_org' });

    await repository.complete(completeInput('usr_owner', 'req_owner'));
    await expect(
      repository.reserve(reserveInput('usr_owner', 'req_replay')),
    ).resolves.toEqual({
      kind: 'replay',
      responseStatus: 201,
      responseBody: { invitationId: 'oiv_1' },
    });
  });

  it('allows one concurrent claim for one scoped key', async () => {
    const results = await Promise.all([
      repository.reserve(reserveInput('usr_owner', 'req_1')),
      repository.reserve(reserveInput('usr_owner', 'req_2')),
    ]);

    expect(results.filter((result) => result.kind === 'claimed')).toHaveLength(
      1,
    );
    expect(results).toContainEqual({ kind: 'conflict', reason: 'pending' });
  });
});
