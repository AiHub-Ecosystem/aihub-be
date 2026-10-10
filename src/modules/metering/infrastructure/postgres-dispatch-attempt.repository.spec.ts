import { OPERATION_IDS } from '@/catalog/operation-id';
import type { DispatchAttemptStart } from '@/modules/metering/public/dispatch-attempts';
import {
  INSERT_DISPATCH_ATTEMPT_SQL,
  PostgresDispatchAttemptRepository,
  UNRESOLVED_DISPATCH_ATTEMPTS_SQL,
  UPDATE_DISPATCH_ATTEMPT_OUTCOME_SQL,
} from './postgres-dispatch-attempt.repository';
import type { PostgresMeteringClient } from './postgres-usage.repository';

class FakePostgres implements PostgresMeteringClient {
  readonly queries: Array<{
    readonly text: string;
    readonly values: readonly unknown[];
  }> = [];
  rows: readonly unknown[] = [];

  async query(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly unknown[]> {
    this.queries.push({ text, values });
    return this.rows;
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
      {
        text: INSERT_DISPATCH_ATTEMPT_SQL,
        values: [attemptId, 'req-1', 'org-1', 'writing.task1.grade', 60_000],
      },
    ]);
    expect(INSERT_DISPATCH_ATTEMPT_SQL).toContain('unknown_after');
    expect(INSERT_DISPATCH_ATTEMPT_SQL).toContain('INTERVAL');
    expect(INSERT_DISPATCH_ATTEMPT_SQL).not.toMatch(/essay|audio|body/i);
  });

  it.each(['response_received', 'not_dispatched', 'outcome_unknown'] as const)(
    'records the %s outcome once',
    async (outcome) => {
      const client = new FakePostgres();
      const repository = new PostgresDispatchAttemptRepository(client);

      await repository.recordOutcome('attempt-id', outcome);

      expect(client.queries).toEqual([
        {
          text: UPDATE_DISPATCH_ATTEMPT_OUTCOME_SQL,
          values: ['attempt-id', outcome],
        },
      ]);
      expect(UPDATE_DISPATCH_ATTEMPT_OUTCOME_SQL).toContain('outcome IS NULL');
    },
  );

  it('returns unresolved counts with a bounded fallback for retired operations', async () => {
    const client = new FakePostgres();
    client.rows = [
      { operation: 'writing.task1.grade', unresolved_count: '2' },
      { operation: 'other', unresolved_count: '3' },
    ];
    const repository = new PostgresDispatchAttemptRepository(client);

    await expect(repository.getUnresolvedByOperation()).resolves.toEqual([
      { operation: 'writing.task1.grade', count: 2 },
      { operation: 'writing.task2.grade', count: 0 },
      { operation: 'speaking.grading', count: 0 },
      { operation: 'speaking.grading-json', count: 0 },
      { operation: 'other', count: 3 },
    ]);
    expect(client.queries).toEqual([
      { text: UNRESOLVED_DISPATCH_ATTEMPTS_SQL, values: [OPERATION_IDS] },
    ]);
    expect(UNRESOLVED_DISPATCH_ATTEMPTS_SQL).toContain('unknown_after');
    expect(UNRESOLVED_DISPATCH_ATTEMPTS_SQL).toContain('usage_records');
    expect(UNRESOLVED_DISPATCH_ATTEMPTS_SQL).toContain('outcome_unknown');
    expect(UNRESOLVED_DISPATCH_ATTEMPTS_SQL).toContain(
      "error_code IS DISTINCT FROM 'AI_SERVICE_TIMEOUT'",
    );
    expect(UNRESOLVED_DISPATCH_ATTEMPTS_SQL).toContain('ANY($1::text[])');
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
