import { PostgresIdempotencyRepository } from './postgres-idempotency.repository';

class QueueClient {
  readonly queries: { values: readonly unknown[] }[] = [];

  constructor(private readonly responses: readonly (readonly unknown[])[]) {}

  async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
    void query;
    this.queries.push({ values });
    return (this.responses[this.queries.length - 1] ?? []) as T;
  }
}

const baseInput = {
  organizationId: 'org_acme',
  operation: 'writing.task1.grade' as const,
  actorScope: '',
  idempotencyKey: 'grade-1',
  fingerprintHex: 'a'.repeat(64),
  requestId: 'req_1',
  expiresAt: new Date('2026-09-08T00:00:00.000Z'),
};

const completeInput = {
  organizationId: baseInput.organizationId,
  operation: baseInput.operation,
  actorScope: baseInput.actorScope,
  idempotencyKey: baseInput.idempotencyKey,
  requestId: baseInput.requestId,
  responseStatus: 200,
  responseBody: { operation: baseInput.operation },
};

const attemptInput = {
  organizationId: baseInput.organizationId,
  operation: baseInput.operation,
  actorScope: baseInput.actorScope,
  idempotencyKey: baseInput.idempotencyKey,
  requestId: baseInput.requestId,
};

describe('PostgresIdempotencyRepository', () => {
  it('looks up only an unexpired completed row with the exact fingerprint', async () => {
    const client = new QueueClient([
      [
        {
          request_id: 'req_old',
          state: 'completed',
          response_status: 200,
          response_body: { stored: true },
        },
      ],
    ]);
    const repository = new PostgresIdempotencyRepository(client);

    await expect(
      repository.findCompletedMatch({
        organizationId: baseInput.organizationId,
        operation: baseInput.operation,
        actorScope: '',
        idempotencyKey: baseInput.idempotencyKey,
        fingerprintHex: baseInput.fingerprintHex,
      }),
    ).resolves.toEqual({
      responseStatus: 200,
      responseBody: { stored: true },
    });

    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]?.values).toEqual([
      baseInput.organizationId,
      baseInput.operation,
      '',
      baseInput.idempotencyKey,
      baseInput.fingerprintHex,
    ]);
  });

  it('claims a new row from the insert and does not issue a second query', async () => {
    const client = new QueueClient([[{ request_id: 'req_1' }]]);
    const repository = new PostgresIdempotencyRepository(client);

    await expect(repository.reserve(baseInput)).resolves.toEqual({
      kind: 'claimed',
      requestId: 'req_1',
    });
    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]?.values[2]).toBe('');
  });

  it('binds management reservations to the authenticated caller scope', async () => {
    const client = new QueueClient([[{ request_id: 'req_management' }]]);
    const repository = new PostgresIdempotencyRepository(client);

    await expect(
      repository.reserve({ ...baseInput, actorScope: 'usr_owner' }),
    ).resolves.toEqual({
      kind: 'claimed',
      requestId: 'req_management',
    });
    expect(client.queries[0]?.values[2]).toBe('usr_owner');
  });

  it('atomically reclaims failed rows and uses the fingerprint for completed replay', async () => {
    const failedClient = new QueueClient([[], [{ request_id: 'req_2' }]]);
    const failedRepository = new PostgresIdempotencyRepository(failedClient);
    await expect(
      failedRepository.reserve({ ...baseInput, requestId: 'req_2' }),
    ).resolves.toEqual({ kind: 'claimed', requestId: 'req_2' });
    expect(failedClient.queries).toHaveLength(2);

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

  it('reclaims an expired pending row even when the new fingerprint differs', async () => {
    const client = new QueueClient([[], [{ request_id: 'req_expired' }]]);
    const repository = new PostgresIdempotencyRepository(client);

    await expect(
      repository.reserve({
        ...baseInput,
        fingerprintHex: 'b'.repeat(64),
        requestId: 'req_expired',
      }),
    ).resolves.toEqual({ kind: 'claimed', requestId: 'req_expired' });
    expect(client.queries).toHaveLength(2);
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

  it('fails when completion does not update the claimed row', async () => {
    const repository = new PostgresIdempotencyRepository(new QueueClient([[]]));

    await expect(repository.complete(completeInput)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      httpStatus: 500,
    });
  });

  it('accepts each state transition only when Postgres returns the claimed row', async () => {
    const client = new QueueClient([
      [{ request_id: baseInput.requestId }],
      [{ request_id: baseInput.requestId }],
      [{ request_id: baseInput.requestId }],
    ]);
    const repository = new PostgresIdempotencyRepository(client);

    await expect(repository.complete(completeInput)).resolves.toBeUndefined();
    await expect(repository.markFailed(attemptInput)).resolves.toBeUndefined();
    await expect(repository.delete(attemptInput)).resolves.toBeUndefined();
    expect(client.queries).toHaveLength(3);
  });

  it('fails when marking a claimed row does not update it', async () => {
    const repository = new PostgresIdempotencyRepository(new QueueClient([[]]));

    await expect(repository.markFailed(attemptInput)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      httpStatus: 500,
    });
  });

  it('fails when deleting a claimed row does not delete it', async () => {
    const repository = new PostgresIdempotencyRepository(new QueueClient([[]]));

    await expect(repository.delete(attemptInput)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      httpStatus: 500,
    });
  });

  it('deletes expired records in one cleanup query', async () => {
    const client = new QueueClient([[{ request_id: 'req_expired' }]]);
    const repository = new PostgresIdempotencyRepository(client);

    await expect(repository.cleanupExpired()).resolves.toBe(1);
    expect(client.queries).toHaveLength(1);
  });
});
