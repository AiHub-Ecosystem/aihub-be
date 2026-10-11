import { OPERATION_IDS } from '@/catalog/operation-id';
import type { DispatchAttemptStart } from '@/modules/metering/public/dispatch-attempts';
import { PostgresDispatchAttemptRepository } from './postgres-dispatch-attempt.repository';
import type {
  PostgresMeteringClient,
  PostgresTransactionClient,
} from './postgres-usage.repository';

class FakePostgres implements PostgresMeteringClient {
  readonly queries: (readonly unknown[])[] = [];
  rows: readonly unknown[] = [];

  async query<Row extends object = Record<string, unknown>>(
    _text: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]> {
    this.queries.push(values);
    return this.rows as readonly Row[];
  }

  async transaction<T>(
    callback: (client: PostgresTransactionClient) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }

  async close(): Promise<void> {}
}

describe('PostgresDispatchAttemptRepository', () => {
  it('stores metadata and a fixed deadline without accepting request content', async () => {
    const client = new FakePostgres();
    const repository = new PostgresDispatchAttemptRepository(client);
    const input: DispatchAttemptStart = {
      requestId: 'req-1',
      organizationId: 'org-1',
      operation: 'writing.task1.grade',
      operationTimeoutMs: 60_000,
    };

    const attemptId = await repository.beginAttempt(input);

    expect(attemptId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(client.queries).toEqual([
      [attemptId, 'req-1', 'org-1', 'writing.task1.grade', 60_000],
    ]);
  });

  it.each(['response_received', 'not_dispatched', 'outcome_unknown'] as const)(
    'records the %s outcome once',
    async (outcome) => {
      const client = new FakePostgres();
      const repository = new PostgresDispatchAttemptRepository(client);

      await repository.recordOutcome('attempt-id', outcome);

      expect(client.queries).toEqual([['attempt-id', outcome]]);
    },
  );

  it('returns unresolved counts with a bounded fallback for retired operations', async () => {
    const client = new FakePostgres();
    client.rows = [
      { operation: 'writing.task1.grade', unresolved_count: 2n },
      { operation: 'other', unresolved_count: 3n },
    ];
    const repository = new PostgresDispatchAttemptRepository(client);

    await expect(repository.getUnresolvedByOperation()).resolves.toEqual([
      { operation: 'writing.task1.grade', count: 2 },
      { operation: 'writing.task2.grade', count: 0 },
      { operation: 'speaking.grading', count: 0 },
      { operation: 'speaking.grading-json', count: 0 },
      { operation: 'other', count: 3 },
    ]);
    expect(client.queries).toEqual([[OPERATION_IDS]]);
  });

  it('returns zero counts for every operation when no attempt is unresolved', async () => {
    const repository = new PostgresDispatchAttemptRepository(
      new FakePostgres(),
    );

    await expect(repository.getUnresolvedByOperation()).resolves.toEqual([
      { operation: 'writing.task1.grade', count: 0 },
      { operation: 'writing.task2.grade', count: 0 },
      { operation: 'speaking.grading', count: 0 },
      { operation: 'speaking.grading-json', count: 0 },
    ]);
  });
});
