import { randomUUID } from 'node:crypto';
import { type Server, createServer } from 'node:http';

import { ulid } from 'ulid';

import { calculateUsageRetentionCutoff } from '@/modules/metering/application/usage-retention';
import { PostgresDispatchAttemptRepository } from '@/modules/metering/infrastructure/postgres-dispatch-attempt.repository';
import { PostgresUsageRetentionRepository } from '@/modules/metering/infrastructure/postgres-usage-retention.repository';
import { createPostgresMeteringClient } from '@/modules/metering/infrastructure/postgres-usage.repository';
import {
  createSandboxTestRedis,
  createTestPool,
  testDatabaseUrl,
} from '../shared/database';
import {
  type HttpAnswer,
  type TestWorker,
  WRITING_TASK1_PATH,
  deleteGradingOrganization,
  killWorker,
  listen,
  monthKey,
  seedGradingOrganization,
  sendRequest,
  startWorker,
} from './app-worker';

const ESSAY_MARKER = 'dispatch-attempt-crash-essay-marker';

function sendGradingRequest(
  appUrl: string,
  apiKey: string,
  assertion: string,
  idempotencyKey: string,
): Promise<HttpAnswer | undefined> {
  return sendRequest(appUrl, {
    path: WRITING_TASK1_PATH,
    headers: {
      'x-api-key': apiKey,
      'x-user-identity': assertion,
      'idempotency-key': idempotencyKey,
    },
    body: {
      question: 'Crash durability test',
      chart_type: 'Bar Chart',
      essay: ESSAY_MARKER,
      image_url: 'https://example.com/chart.png',
    },
  });
}

describe('durable dispatch-attempt evidence', () => {
  const pool = createTestPool();
  const redis = createSandboxTestRedis();
  let provider: Server | undefined;
  let dispatchWorker: TestWorker | undefined;
  let metricsWorker: TestWorker | undefined;
  let crashOrganizationId: string | undefined;

  afterEach(async () => {
    await dispatchWorker?.stop();
    await metricsWorker?.stop();
    dispatchWorker = undefined;
    metricsWorker = undefined;
    if (provider !== undefined) {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider?.close(() => resolve()));
      provider = undefined;
    }
    if (crashOrganizationId !== undefined) {
      await deleteGradingOrganization(pool, crashOrganizationId);
      crashOrganizationId = undefined;
    }
  });

  afterAll(async () => {
    redis.disconnect();
    await pool.end();
  });

  it('survives a real AIHUB Nest process kill and restart without usage or quota', async () => {
    const baselineRepository = new PostgresDispatchAttemptRepository(
      createPostgresMeteringClient(testDatabaseUrl()),
    );
    const baseline = await baselineRepository.getUnresolvedByOperation();
    const baselineCount =
      baseline.find((sample) => sample.operation === 'writing.task1.grade')
        ?.count ?? 0;
    await baselineRepository.close();
    const { organizationId, apiKey, assertion } = await seedGradingOrganization(
      pool,
      {
        label: 'dispatch_crash',
        maxConcurrent: 20,
        monthlyQuota: 10,
        hardStop: true,
      },
    );
    crashOrganizationId = organizationId;
    let resolveProviderReceived!: () => void;
    const providerReceived = new Promise<void>((resolve) => {
      resolveProviderReceived = resolve;
    });
    provider = createServer((request) => {
      request.resume();
      request.once('end', resolveProviderReceived);
    });
    const providerUrl = await listen(provider);

    await redis.del(`aihub:v1:quota:${organizationId}:${monthKey(new Date())}`);
    dispatchWorker = await startWorker({
      downstreamUrl: providerUrl,
    });
    const customerResponse = sendGradingRequest(
      dispatchWorker.url,
      apiKey.raw,
      assertion,
      `dispatch-crash-${ulid()}`,
    );
    let dispatchWaitTimer: NodeJS.Timeout | undefined;
    const dispatchStarted = await Promise.race([
      providerReceived.then(() => 'provider_received'),
      customerResponse.then((response) =>
        response === undefined
          ? 'customer_disconnected'
          : `customer_response_${response.status}:${response.body}`,
      ),
      new Promise<string>(
        (resolve) =>
          (dispatchWaitTimer = setTimeout(
            () => resolve('dispatch_wait_timeout'),
            10_000,
          )),
      ),
    ]);
    if (dispatchWaitTimer !== undefined) clearTimeout(dispatchWaitTimer);
    if (dispatchStarted !== 'provider_received') {
      throw new Error(
        `AIHUB did not reach the mock AI Service: ${dispatchStarted}`,
      );
    }

    await killWorker(dispatchWorker);
    dispatchWorker = undefined;
    await customerResponse;

    const attempt = await pool.query<{
      attempt_id: string;
      request_id: string;
      operation: string;
      outcome: string | null;
      unknown_after: Date;
      stored: Record<string, unknown>;
    }>(
      `SELECT attempt_id, request_id, operation, outcome, unknown_after,
              row_to_json(dispatch_attempts) AS stored
       FROM dispatch_attempts WHERE organization_id = $1`,
      [organizationId],
    );
    expect(attempt.rows).toHaveLength(1);
    expect(attempt.rows[0]).toMatchObject({
      operation: 'writing.task1.grade',
      outcome: null,
    });
    expect(JSON.stringify(attempt.rows[0]?.stored)).not.toContain(ESSAY_MARKER);
    expect(
      await pool.query('SELECT 1 FROM usage_records WHERE request_id = $1', [
        attempt.rows[0]?.request_id,
      ]),
    ).toMatchObject({ rowCount: 0 });
    // Admission rebuilt the deleted counter from durable usage (#371); the
    // killed request never added to it.
    expect(
      await redis.get(
        `aihub:v1:quota:${organizationId}:${monthKey(new Date())}`,
      ),
    ).toBe('0');

    await pool.query(
      `UPDATE dispatch_attempts
       SET unknown_after = clock_timestamp() - INTERVAL '1 millisecond'
       WHERE attempt_id = $1`,
      [attempt.rows[0]?.attempt_id],
    );
    metricsWorker = await startWorker({
      downstreamUrl: providerUrl,
    });
    const metrics = await fetch(`${metricsWorker.url}/metrics`).then(
      (response) => response.text(),
    );
    expect(metrics).toContain(
      `aihub_dispatch_attempts_unresolved{operation="writing.task1.grade"} ${baselineCount + 1}`,
    );
  }, 90_000);

  it('applies timeout usage and retired-operation rules against real Postgres rows', async () => {
    const repository = new PostgresDispatchAttemptRepository(
      createPostgresMeteringClient(testDatabaseUrl()),
    );
    const requestIds = Array.from(
      { length: 9 },
      () => `req_dispatch_metric_${ulid()}`,
    );
    const attemptIds = requestIds.map(() => randomUUID());
    const now = new Date();
    const createdAt = new Date(now.getTime() - 10_000);
    const overdue = new Date(now.getTime() - 1_000);
    const future = new Date(now.getTime() + 60_000);
    const baseline = await repository.getUnresolvedByOperation();
    const baselineCount =
      baseline.find((sample) => sample.operation === 'writing.task1.grade')
        ?.count ?? 0;
    const baselineOtherCount =
      baseline.find((sample) => sample.operation === 'other')?.count ?? 0;

    try {
      const attempts = [
        {
          operation: 'writing.task1.grade',
          outcome: null,
          unknownAfter: overdue,
        },
        {
          operation: 'writing.task1.grade',
          outcome: null,
          unknownAfter: overdue,
        },
        {
          operation: 'writing.task1.grade',
          outcome: null,
          unknownAfter: future,
        },
        {
          operation: 'writing.task1.grade',
          outcome: 'response_received',
          unknownAfter: overdue,
        },
        {
          operation: 'writing.task1.grade',
          outcome: 'outcome_unknown',
          unknownAfter: overdue,
        },
        {
          operation: 'writing.task1.grade',
          outcome: null,
          unknownAfter: overdue,
        },
        {
          operation: 'writing.task1.grade',
          outcome: null,
          unknownAfter: overdue,
        },
        {
          operation: 'writing.retired.grade',
          outcome: null,
          unknownAfter: overdue,
        },
        {
          operation: 'speaking.retired.grade',
          outcome: null,
          unknownAfter: overdue,
        },
      ] as const;
      for (const [index, attempt] of attempts.entries()) {
        await pool.query(
          `INSERT INTO dispatch_attempts
             (attempt_id, request_id, organization_id, operation, created_at,
              unknown_after, outcome)
           VALUES ($1, $2, 'org_dispatch_metric_test', $3, $4, $5, $6)`,
          [
            attemptIds[index],
            requestIds[index],
            attempt.operation,
            createdAt,
            attempt.unknownAfter,
            attempt.outcome,
          ],
        );
      }
      for (const [index, errorCode, outcome, status] of [
        [1, null, 'success', 200],
        [5, 'AI_SERVICE_TIMEOUT', 'downstream_error', 504],
        [6, 'AI_SERVICE_TIMEOUT', 'downstream_error', 504],
      ] as const) {
        await pool.query(
          `INSERT INTO usage_records
           (request_id, organization_id, api_key_id, service, operation,
            environment, outcome, http_status, error_code, metering_status,
            total_ms)
         VALUES ($1, 'org_dispatch_metric_test', 'ak_dispatch_metric_test',
                 'ai-writing', 'writing.task1.grade', 'production', $2, $3,
                 $4, 'complete', 0)`,
          [requestIds[index], outcome, status, errorCode],
        );
      }

      const samples = await repository.getUnresolvedByOperation();
      const unresolvedCount =
        samples.find((sample) => sample.operation === 'writing.task1.grade')
          ?.count ?? 0;
      expect(unresolvedCount - baselineCount).toBe(4);
      const otherCount =
        samples.find((sample) => sample.operation === 'other')?.count ?? 0;
      expect(otherCount - baselineOtherCount).toBe(2);
    } finally {
      await pool.query('DELETE FROM usage_records WHERE request_id = ANY($1)', [
        requestIds,
      ]);
      await pool.query(
        'DELETE FROM dispatch_attempts WHERE attempt_id = ANY($1::uuid[])',
        [attemptIds],
      );
      await repository.close();
    }
  });

  it('prunes only dispatch evidence strictly older than the retention cutoff in bounded batches', async () => {
    const cutoff = calculateUsageRetentionCutoff(new Date());
    const attemptIds = [randomUUID(), randomUUID(), randomUUID()];
    const requestIds = attemptIds.map((id) => `req_retention_${id}`);
    const createdAt = [
      new Date(cutoff.getTime() - 1),
      cutoff,
      new Date(cutoff.getTime() + 1),
    ];
    for (const [index, attemptId] of attemptIds.entries()) {
      await pool.query(
        `INSERT INTO dispatch_attempts
           (attempt_id, request_id, organization_id, operation, created_at,
            unknown_after, outcome)
         VALUES ($1, $2, 'org-retention-test', 'writing.task1.grade',
                 $3::timestamptz, $4::timestamptz, NULL)`,
        [
          attemptId,
          requestIds[index],
          createdAt[index],
          new Date(createdAt[index]!.getTime() + 1000),
        ],
      );
    }
    const repository = new PostgresUsageRetentionRepository(
      createPostgresMeteringClient(testDatabaseUrl()),
    );

    await expect(repository.pruneDispatchAttempts(cutoff, 1)).resolves.toBe(1);
    await expect(repository.pruneDispatchAttempts(cutoff, 1)).resolves.toBe(0);
    const remaining = await pool.query<{ attempt_id: string }>(
      'SELECT attempt_id FROM dispatch_attempts WHERE request_id = ANY($1::text[]) ORDER BY attempt_id',
      [requestIds],
    );
    expect(remaining.rows.map((row) => row.attempt_id)).toEqual(
      [attemptIds[1], attemptIds[2]].sort((a, b) =>
        String(a).localeCompare(String(b)),
      ),
    );
    await repository.close();
  });
});
