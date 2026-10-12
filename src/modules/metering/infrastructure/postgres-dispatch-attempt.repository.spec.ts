import { OPERATION_IDS } from '@/catalog/operation-id';
import type { DispatchAttemptStart } from '@/modules/metering/public/dispatch-attempts';
import type { PrismaClient } from '@prisma-client/client';
import { PostgresDispatchAttemptRepository } from './postgres-dispatch-attempt.repository';

function fakePrisma(rows: readonly unknown[] = []) {
  const query = jest.fn().mockResolvedValue(rows);
  const execute = jest.fn().mockResolvedValue(1);
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  return {
    client: {
      $queryRawUnsafe: query,
      $executeRawUnsafe: execute,
      dispatchAttempt: { updateMany },
    } as unknown as PrismaClient,
    query,
    execute,
    updateMany,
  };
}

describe('PostgresDispatchAttemptRepository', () => {
  it('stores metadata and a fixed deadline without accepting request content', async () => {
    const { client, execute } = fakePrisma();
    const repository = new PostgresDispatchAttemptRepository(client);
    const input: DispatchAttemptStart = {
      requestId: 'req-1',
      organizationId: 'org-1',
      operation: 'writing.task1.grade',
      operationTimeoutMs: 60_000,
    };

    const attemptId = await repository.beginAttempt(input);

    expect(attemptId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(execute).toHaveBeenCalledWith(
      expect.any(String),
      attemptId,
      'req-1',
      'org-1',
      'writing.task1.grade',
      60_000,
    );
  });

  it.each(['response_received', 'not_dispatched', 'outcome_unknown'] as const)(
    'records the %s outcome once',
    async (outcome) => {
      const { client, updateMany } = fakePrisma();
      const repository = new PostgresDispatchAttemptRepository(client);

      await repository.recordOutcome('attempt-id', outcome);

      expect(updateMany).toHaveBeenCalledWith({
        where: { attemptId: 'attempt-id', outcome: null },
        data: { outcome },
      });
    },
  );

  it('returns unresolved counts with a bounded fallback for retired operations', async () => {
    const { client, query } = fakePrisma([
      { operation: 'writing.task1.grade', unresolved_count: 2n },
      { operation: 'other', unresolved_count: 3n },
    ]);
    const repository = new PostgresDispatchAttemptRepository(client);

    await expect(repository.getUnresolvedByOperation()).resolves.toEqual([
      { operation: 'writing.task1.grade', count: 2 },
      { operation: 'writing.task2.grade', count: 0 },
      { operation: 'speaking.grading', count: 0 },
      { operation: 'speaking.grading-json', count: 0 },
      { operation: 'other', count: 3 },
    ]);
    expect(query).toHaveBeenCalledWith(expect.any(String), [...OPERATION_IDS]);
  });

  it('returns zero counts for every operation when no attempt is unresolved', async () => {
    const repository = new PostgresDispatchAttemptRepository(
      fakePrisma().client,
    );

    await expect(repository.getUnresolvedByOperation()).resolves.toEqual([
      { operation: 'writing.task1.grade', count: 0 },
      { operation: 'writing.task2.grade', count: 0 },
      { operation: 'speaking.grading', count: 0 },
      { operation: 'speaking.grading-json', count: 0 },
    ]);
  });
});
