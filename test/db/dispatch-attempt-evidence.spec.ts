import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type Server, createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { ulid } from 'ulid';

import { generateApiKey } from '@/modules/identity/domain/api-key';
import { calculateUsageRetentionCutoff } from '@/modules/metering/application/usage-retention';
import { PostgresDispatchAttemptRepository } from '@/modules/metering/infrastructure/postgres-dispatch-attempt.repository';
import { PostgresUsageRetentionRepository } from '@/modules/metering/infrastructure/postgres-usage-retention.repository';
import { createPostgresMeteringClient } from '@/modules/metering/infrastructure/postgres-usage.repository';
import {
  createSandboxTestRedis,
  createTestPool,
  sandboxTestRedisUrl,
  testDatabaseUrl,
} from './database';
import {
  createTenantIdentity,
  signUserAssertion,
} from './tenant-isolation/fixtures';

interface TestWorker {
  readonly child: ChildProcess;
  readonly url: string;
  stop(): Promise<void>;
}

const ESSAY_MARKER = 'dispatch-attempt-crash-essay-marker';
const OPERATION_PATH = '/v1/ielts/writing/task1/grade';

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('mock AI Service did not expose a port'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function startWorker(configuration: {
  readonly downstreamUrl: string;
}): Promise<TestWorker> {
  const worker = spawn(
    process.execPath,
    [
      join(process.cwd(), 'node_modules/jest/bin/jest.js'),
      '--config',
      'jest.config.db-worker.cjs',
      '--runInBand',
      '--runTestsByPath',
      join(__dirname, 'dispatch-attempt-crash.worker.spec.ts'),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AIHUB_RUNTIME_SECRET_SOURCE: 'env',
        AIHUB_RUNTIME_DATABASE_SCOPE: 'production',
        DATABASE_URL: testDatabaseUrl(),
        CONTROL_PLANE_DATABASE_URL: testDatabaseUrl(),
        CONTROL_PLANE_READ_DATABASE_URL: testDatabaseUrl(),
        REDIS_URL: sandboxTestRedisUrl(),
        DOWNSTREAM_AI_WRITING_URL: configuration.downstreamUrl,
        DOWNSTREAM_AI_SPEAKING_URL: configuration.downstreamUrl,
        AIHUB_PRODUCTION_HOST: 'api.production.test',
        AIHUB_STAGING_HOST: 'api.staging.test',
        AIHUB_DEVELOPMENT_HOST: 'api.development.test',
        AIHUB_SANDBOX_HOST: 'api.sandbox.test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderr = '';
  worker.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ready = new Promise<number>((resolve, reject) => {
    const lines = createInterface({ input: worker.stdout! });
    const timeout = setTimeout(() => {
      lines.close();
      reject(new Error(`AIHUB test worker did not start: ${stderr}`));
    }, 45_000);
    lines.on('line', (line) => {
      const port = Number(line.match(/^AIHUB_TEST_READY:(\d+)$/)?.[1]);
      if (Number.isSafeInteger(port) && port > 0) {
        clearTimeout(timeout);
        lines.close();
        resolve(port);
      }
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`AIHUB test worker exited before ready (${code}): ${stderr}`),
      );
    });
  });
  let port: number;
  try {
    port = await ready;
  } catch (error) {
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGKILL');
      await once(worker, 'exit').catch(() => undefined);
    }
    throw error;
  }
  return {
    child: worker,
    url: `http://127.0.0.1:${port}`,
    async stop() {
      if (worker.exitCode !== null || worker.signalCode !== null) return;
      const exited = once(worker, 'exit');
      worker.kill('SIGTERM');
      await exited;
    },
  };
}

function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function sendGradingRequest(
  appUrl: string,
  apiKey: string,
  assertion: string,
  idempotencyKey: string,
): Promise<{ status: number; body: string } | undefined> {
  const app = new URL(appUrl);
  return new Promise((resolve) => {
    const request = httpRequest(
      {
        hostname: app.hostname,
        port: Number(app.port),
        path: OPERATION_PATH,
        method: 'POST',
        headers: {
          host: 'api.production.test',
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'x-user-identity': assertion,
          'idempotency-key': idempotencyKey,
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body }),
        );
      },
    );
    request.on('error', () => resolve(undefined));
    request.end(
      JSON.stringify({
        question: 'Crash durability test',
        chart_type: 'Bar Chart',
        essay: ESSAY_MARKER,
        image_url: 'https://example.com/chart.png',
      }),
    );
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
      await pool.query('DELETE FROM usage_records WHERE organization_id = $1', [
        crashOrganizationId,
      ]);
      await pool.query(
        'DELETE FROM dispatch_attempts WHERE organization_id = $1',
        [crashOrganizationId],
      );
      await pool.query(
        'DELETE FROM idempotency_records WHERE organization_id = $1',
        [crashOrganizationId],
      );
      await pool.query(
        'DELETE FROM sandbox_dispatch_reservations WHERE organization_id = $1',
        [crashOrganizationId],
      );
      await pool.query('DELETE FROM api_keys WHERE organization_id = $1', [
        crashOrganizationId,
      ]);
      await pool.query(
        'DELETE FROM organization_identity_configs WHERE organization_id = $1',
        [crashOrganizationId],
      );
      await pool.query('DELETE FROM organizations WHERE id = $1', [
        crashOrganizationId,
      ]);
      crashOrganizationId = undefined;
    }
  });

  afterAll(async () => {
    redis.disconnect();
    await pool.end();
  });

  it('survives a real AIHUB Nest process kill and restart without usage or quota', async () => {
    const organizationId = `org_dispatch_crash_${ulid().toLowerCase()}`;
    crashOrganizationId = organizationId;
    const baselineRepository = new PostgresDispatchAttemptRepository(
      createPostgresMeteringClient(testDatabaseUrl()),
    );
    const baseline = await baselineRepository.getUnresolvedByOperation();
    const baselineCount =
      baseline.find((sample) => sample.operation === 'writing.task1.grade')
        ?.count ?? 0;
    await baselineRepository.close();
    const apiKey = generateApiKey(`ak_dispatch_crash_${ulid().toLowerCase()}`);
    const identity = await createTenantIdentity(
      'https://identity.dispatch-crash.test',
      `dispatch-crash-${ulid().toLowerCase()}`,
    );
    const assertion = await signUserAssertion(identity, new Date());
    await pool.query(
      `INSERT INTO organizations
         (id, name, entitlements, rate_limit_rpm, max_concurrent,
          monthly_request_quota, hard_stop_on_quota)
       VALUES ($1, 'Dispatch crash test', ARRAY['writing'], 600, 20, 10, true)`,
      [organizationId],
    );
    await pool.query(
      `INSERT INTO api_keys
         (id, organization_id, key_hash, key_prefix, name, scopes,
          allowed_environments, status)
       VALUES ($1, $2, decode($3, 'hex'), $4, 'Dispatch crash test',
         ARRAY['writing.grade'], ARRAY['production'], 'active')`,
      [apiKey.id, organizationId, apiKey.hash, apiKey.prefix],
    );
    await pool.query(
      `INSERT INTO organization_identity_configs
         (organization_id, issuer, jwks_url, public_keys_jwks,
          allowed_algorithms, max_assertion_ttl_seconds, status)
       VALUES ($1, $2, NULL, $3::jsonb, ARRAY['RS256'], 300, 'active')`,
      [organizationId, identity.issuer, JSON.stringify(identity.jwks)],
    );
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

    const workerExit = once(dispatchWorker.child, 'exit');
    dispatchWorker.child.kill('SIGKILL');
    await workerExit;
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
    expect(
      await redis.get(
        `aihub:v1:quota:${organizationId}:${monthKey(new Date())}`,
      ),
    ).toBeNull();

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

  it('applies unresolved metric exclusions against real Postgres rows', async () => {
    const repository = new PostgresDispatchAttemptRepository(
      createPostgresMeteringClient(testDatabaseUrl()),
    );
    const requestIds = Array.from(
      { length: 5 },
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

    try {
      const attempts = [
        { outcome: null, unknownAfter: overdue },
        { outcome: null, unknownAfter: overdue },
        { outcome: null, unknownAfter: future },
        { outcome: 'response_received', unknownAfter: overdue },
        { outcome: 'outcome_unknown', unknownAfter: overdue },
      ] as const;
      for (const [index, attempt] of attempts.entries()) {
        await pool.query(
          `INSERT INTO dispatch_attempts
             (attempt_id, request_id, organization_id, operation, created_at,
              unknown_after, outcome)
           VALUES ($1, $2, 'org_dispatch_metric_test',
                   'writing.task1.grade', $3, $4, $5)`,
          [
            attemptIds[index],
            requestIds[index],
            createdAt,
            attempt.unknownAfter,
            attempt.outcome,
          ],
        );
      }
      await pool.query(
        `INSERT INTO usage_records
           (request_id, organization_id, api_key_id, service, operation,
            environment, outcome, http_status, metering_status, total_ms)
         VALUES ($1, 'org_dispatch_metric_test', 'ak_dispatch_metric_test',
                 'ai-writing', 'writing.task1.grade', 'production',
                 'success', 200, 'complete', 0)`,
        [requestIds[1]],
      );

      const samples = await repository.getUnresolvedByOperation();
      const unresolvedCount =
        samples.find((sample) => sample.operation === 'writing.task1.grade')
          ?.count ?? 0;
      expect(unresolvedCount - baselineCount).toBe(2);
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
      [attemptIds[1], attemptIds[2]].sort(),
    );
    await repository.close();
  });
});
