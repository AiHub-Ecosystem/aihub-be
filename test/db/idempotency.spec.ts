import type { Pool } from 'pg';

import { ORGANIZATION_CREATE_OPERATION } from '@/modules/idempotency/application/idempotency-operation';
import type {
  CompleteIdempotencyInput,
  ReserveIdempotencyInput,
} from '@/modules/idempotency/application/idempotency-repository.port';
import type { PostgresIdempotencyClient } from '@/modules/idempotency/infrastructure/postgres-idempotency.client';
import { PostgresIdempotencyRepository } from '@/modules/idempotency/infrastructure/postgres-idempotency.repository';

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
    // Relative to now: a fixed instant expires the record once the calendar
    // passes it, and an expired record is reclaimable rather than replayed.
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
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

  it('keys records by Organization, operation, actor scope, and key with null Organizations distinct from none', async () => {
    const result = await pool.query<{ definition: string }>(`
      SELECT pg_get_indexdef(indexrelid) AS definition
      FROM pg_index
      WHERE indrelid = 'idempotency_records'::regclass
        AND indisunique
    `);

    expect(result.rows.map((row) => row.definition)).toEqual([
      expect.stringContaining(
        '(organization_id, operation, actor_scope, idempotency_key) NULLS NOT DISTINCT',
      ),
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

  it('replays an Account-scoped record that names no Organization', async () => {
    const accountScoped = {
      ...reserveInput('usr_owner', 'req_create'),
      organizationId: null,
      operation: ORGANIZATION_CREATE_OPERATION,
    };

    await expect(repository.reserve(accountScoped)).resolves.toEqual({
      kind: 'claimed',
      requestId: 'req_create',
    });
    await expect(
      repository.reserve({ ...accountScoped, requestId: 'req_race' }),
    ).resolves.toEqual({ kind: 'conflict', reason: 'pending' });
    await expect(
      repository.reserve({
        ...accountScoped,
        actorScope: 'usr_other',
        requestId: 'req_other_caller',
      }),
    ).resolves.toEqual({ kind: 'claimed', requestId: 'req_other_caller' });

    await repository.complete({
      ...completeInput('usr_owner', 'req_create'),
      organizationId: null,
      operation: ORGANIZATION_CREATE_OPERATION,
      responseBody: { organizationId: 'org_new' },
    });

    await expect(
      repository.reserve({ ...accountScoped, requestId: 'req_replay' }),
    ).resolves.toEqual({
      kind: 'replay',
      responseStatus: 201,
      responseBody: { organizationId: 'org_new' },
    });
  });
});
