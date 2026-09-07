import type { PostgresIdempotencyClient } from './postgres-idempotency.client';
import { PostgresIdempotencyRepository } from './postgres-idempotency.repository';

class QueueClient implements PostgresIdempotencyClient {
  readonly queries: { text: string; values: readonly unknown[] }[] = [];

  constructor(private readonly responses: readonly (readonly unknown[])[]) {}

  async query(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly unknown[]> {
    this.queries.push({ text, values });
    return this.responses[this.queries.length - 1] ?? [];
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const baseInput = {
  organizationId: 'org_acme',
  operation: 'writing.task1.grade' as const,
  idempotencyKey: 'grade-1',
  fingerprintHex: 'a'.repeat(64),
  requestId: 'req_1',
  expiresAt: new Date('2026-09-08T00:00:00.000Z'),
};

describe('PostgresIdempotencyRepository', () => {
  it('closes its database client during module shutdown', async () => {
    const client = new QueueClient([]);
    const close = jest.spyOn(client, 'close');
    const repository = new PostgresIdempotencyRepository(client);

    await repository.onModuleDestroy();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('claims a new row from the insert and does not issue a second query', async () => {
    const client = new QueueClient([[{ request_id: 'req_1' }]]);
    const repository = new PostgresIdempotencyRepository(client);

    await expect(repository.reserve(baseInput)).resolves.toEqual({
      kind: 'claimed',
      requestId: 'req_1',
    });
    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]?.text).toContain('ON CONFLICT');
    expect(client.queries[0]?.text).toContain("'pending'");
  });

  it('atomically reclaims failed rows and uses the fingerprint for completed replay', async () => {
    const failedClient = new QueueClient([[], [{ request_id: 'req_2' }]]);
    const failedRepository = new PostgresIdempotencyRepository(failedClient);
    await expect(
      failedRepository.reserve({ ...baseInput, requestId: 'req_2' }),
    ).resolves.toEqual({ kind: 'claimed', requestId: 'req_2' });
    expect(failedClient.queries[1]?.text).toContain("state = 'failed'");
    expect(failedClient.queries[1]?.text).toContain('expires_at <= now()');

    const replayClient = new QueueClient([
      [],
      [],
      [
        {
          request_fingerprint: baseInput.fingerprintHex,
          state: 'completed',
          request_id: 'req_old',
          response_status: 200,
          response_body: { operation: baseInput.operation },
        },
      ],
    ]);
    const replayRepository = new PostgresIdempotencyRepository(replayClient);
    await expect(replayRepository.reserve(baseInput)).resolves.toEqual({
      kind: 'replay',
      responseStatus: 200,
      responseBody: { operation: baseInput.operation },
    });
  });

  it('returns a fingerprint conflict without waiting on a pending row', async () => {
    const client = new QueueClient([
      [],
      [],
      [
        {
          request_fingerprint: 'b'.repeat(64),
          state: 'pending',
          request_id: 'req_old',
          response_status: null,
          response_body: null,
        },
      ],
    ]);
    const repository = new PostgresIdempotencyRepository(client);

    await expect(repository.reserve(baseInput)).resolves.toEqual({
      kind: 'conflict',
      reason: 'fingerprint',
    });
  });

  it('fails closed on a corrupt stored row instead of replaying or deleting it', async () => {
    const client = new QueueClient([
      [],
      [],
      [{ request_fingerprint: { invalid: true }, state: 'completed' }],
    ]);
    const repository = new PostgresIdempotencyRepository(client);

    await expect(repository.reserve(baseInput)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      httpStatus: 500,
    });
  });
});
