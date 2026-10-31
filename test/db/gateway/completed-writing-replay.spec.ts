import Fastify from 'fastify';
import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { findCompletedWritingReplay } from '@/modules/gateway/presentation/completed-writing-replay';
import { createIdempotencyFingerprint } from '@/modules/idempotency/application/idempotency-fingerprint';
import { IdempotencyService } from '@/modules/idempotency/application/idempotency-service';
import type { IdempotencyWork } from '@/modules/idempotency/application/idempotency-service.port';
import { PostgresIdempotencyRepository } from '@/modules/idempotency/infrastructure/postgres-idempotency.repository';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import { prismaFromQueryFake } from '@/modules/persistence/testing/query-fake-client';

import { createTestPool } from '../shared/database';

const ACTOR_ID = 'student-shared';
const OPERATION = 'writing.task1.grade' as const;
const IDEMPOTENCY_KEY = 'writing-replay-shared-key';
const REQUEST_BODY = {
  question: 'Describe the chart.',
  chart_type: 'Bar Chart',
  essay: 'The chart shows a clear trend.',
  image_url: 'https://example.com/chart.png',
};
const RESPONSE_BODY = { marker: 'stored-writing-result' };

let pool: Pool;
let repository: PostgresIdempotencyRepository;
let service: IdempotencyService;
let organizationA: string;
let organizationB: string;

function client() {
  return prismaFromQueryFake({
    async query(text, values) {
      const result = await pool.query<Record<string, unknown>>(text, [
        ...values,
      ]);
      return result.rows;
    },
  });
}

interface ReplayLookup {
  readonly replay: { responseStatus: number; responseBody: unknown } | null;
}

async function lookup(organizationId: string): Promise<ReplayLookup> {
  const app = Fastify();
  app.post('/replay', async (request: AuthenticatedRequest) => {
    request.aihubIdentity = {
      userId: ACTOR_ID,
      organizationId,
      scopes: [],
      mode: 'declared_id',
    };
    const replay = await findCompletedWritingReplay(request, service, {
      organizationId,
      operation: OPERATION,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    return { replay: replay?.replay ?? null };
  });
  const response = await app.inject({
    method: 'POST',
    url: '/replay',
    payload: REQUEST_BODY,
  });
  await app.close();
  expect(response.statusCode).toBe(200);
  return response.json<ReplayLookup>();
}

beforeAll(async () => {
  pool = createTestPool();
  repository = new PostgresIdempotencyRepository(client());
  service = new IdempotencyService(repository);
});

beforeEach(async () => {
  await pool.query('TRUNCATE TABLE idempotency_records');
  organizationA = `org_${ulid()}`;
  organizationB = `org_${ulid()}`;
  await pool.query(
    `INSERT INTO organizations (id, name, status)
     VALUES ($1, $2, 'active'), ($3, $4, 'active')`,
    [
      organizationA,
      `Writing replay ${organizationA}`,
      organizationB,
      `Writing replay ${organizationB}`,
    ],
  );
});

afterAll(async () => {
  await pool.end();
});

/** Stores a completed graded request for the shared actor and key. */
async function storeCompletedReplay(organizationId: string): Promise<string> {
  const fingerprintHex = createIdempotencyFingerprint({
    organizationId,
    operation: OPERATION,
    actorId: ACTOR_ID,
    requestBody: REQUEST_BODY,
  });
  const input = {
    organizationId,
    operation: OPERATION,
    actorScope: '',
    idempotencyKey: IDEMPOTENCY_KEY,
    fingerprintHex,
    requestId: `req_${ulid()}`,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
  };
  await expect(repository.reserve(input)).resolves.toEqual({
    kind: 'claimed',
    requestId: input.requestId,
  });
  await repository.complete({
    organizationId,
    operation: OPERATION,
    actorScope: '',
    idempotencyKey: IDEMPOTENCY_KEY,
    requestId: input.requestId,
    responseStatus: 200,
    responseBody: RESPONSE_BODY,
  });
  return fingerprintHex;
}

describe('completed Writing replay ownership against PostgreSQL', () => {
  it('runs the work for another Organization instead of replaying the stored response', async () => {
    await storeCompletedReplay(organizationB);
    const execute = (organizationId: string, work: IdempotencyWork<unknown>) =>
      service.execute(
        {
          organizationId,
          operation: OPERATION,
          idempotencyKey: IDEMPOTENCY_KEY,
          actorId: ACTOR_ID,
          requestBody: REQUEST_BODY,
          requestId: `req_${ulid()}`,
          timeoutMs: 60_000,
          signal: AbortSignal.timeout(60_000),
          deadlineAt: new Date(Date.now() + 60_000),
        },
        work,
        (value) => value,
      );
    const ownerWork = jest.fn(async () => ({ marker: 'must-not-run' }));
    const otherWork = jest.fn(async () => ({ marker: 'organization-a-fresh' }));

    await expect(execute(organizationB, ownerWork)).resolves.toMatchObject({
      replay: true,
      result: RESPONSE_BODY,
    });
    await expect(execute(organizationA, otherWork)).resolves.toMatchObject({
      replay: false,
      result: { marker: 'organization-a-fresh' },
    });

    expect(ownerWork).not.toHaveBeenCalled();
    expect(otherWork).toHaveBeenCalledTimes(1);
  });

  it('returns only the stored replay for the Organization that owns it', async () => {
    const fingerprintHex = await storeCompletedReplay(organizationB);

    await expect(
      repository.findCompletedMatch({
        organizationId: organizationB,
        operation: OPERATION,
        actorScope: '',
        idempotencyKey: IDEMPOTENCY_KEY,
        fingerprintHex,
      }),
    ).resolves.toEqual({
      responseStatus: 200,
      responseBody: RESPONSE_BODY,
    });
    await expect(
      repository.findCompletedMatch({
        organizationId: organizationA,
        operation: OPERATION,
        actorScope: '',
        idempotencyKey: IDEMPOTENCY_KEY,
        fingerprintHex,
      }),
    ).resolves.toBeUndefined();

    await expect(lookup(organizationB)).resolves.toEqual({
      replay: { responseStatus: 200, responseBody: RESPONSE_BODY },
    });
    await expect(lookup(organizationA)).resolves.toEqual({ replay: null });
  });
});
