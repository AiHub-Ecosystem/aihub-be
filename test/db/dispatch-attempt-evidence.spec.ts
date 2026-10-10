import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type Server, createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { ulid } from 'ulid';

import { calculateUsageRetentionCutoff } from '@/modules/metering/application/usage-retention';
import { PostgresUsageRetentionRepository } from '@/modules/metering/infrastructure/postgres-usage-retention.repository';
import { createPostgresMeteringClient } from '@/modules/metering/infrastructure/postgres-usage.repository';
import {
  createSandboxTestRedis,
  createTestPool,
  sandboxTestRedisUrl,
  testDatabaseUrl,
} from './database';

interface TestWorker {
  readonly child: ChildProcess;
  readonly url: string;
  stop(): Promise<void>;
}

const ESSAY_MARKER = 'dispatch-attempt-crash-essay-marker';
const REQUEST_TIMEOUT_MS = 1000;

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

async function startWorker(
  mode: 'dispatch' | 'metrics',
  configuration: {
    readonly requestId: string;
    readonly organizationId: string;
    readonly downstreamUrl: string;
  },
): Promise<TestWorker> {
  const worker = spawn(
    process.execPath,
    ['--import', 'tsx', join(__dirname, 'dispatch-attempt-crash.worker.ts')],
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
        DISPATCH_TEST_REQUEST_ID: configuration.requestId,
        DISPATCH_TEST_ORGANIZATION_ID: configuration.organizationId,
        DISPATCH_TEST_TIMEOUT_MS: String(REQUEST_TIMEOUT_MS),
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
    }, 20_000);
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

describe('durable dispatch-attempt evidence', () => {
  const pool = createTestPool();
  const redis = createSandboxTestRedis();
  let provider: Server | undefined;
  let dispatchWorker: TestWorker | undefined;
  let metricsWorker: TestWorker | undefined;

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
  });

  afterAll(async () => {
    redis.disconnect();
    await pool.end();
  });

  it('survives a real process kill and appears unresolved after restart without usage or quota', async () => {
    const requestId = `req_${ulid()}`;
    const organizationId = `org_dispatch_crash_${ulid().toLowerCase()}`;
    let resolveProviderReceived!: () => void;
    const providerReceived = new Promise<void>((resolve) => {
      resolveProviderReceived = resolve;
    });
    provider = createServer((request) => {
      request.resume();
      request.once('end', resolveProviderReceived);
    });
    const providerUrl = await listen(provider);

    dispatchWorker = await startWorker('dispatch', {
      requestId,
      organizationId,
      downstreamUrl: providerUrl,
    });
    const customerRequest = fetch(
      `${dispatchWorker.url}/__test/dispatch-attempts/dispatch`,
      { method: 'POST', signal: AbortSignal.timeout(20_000) },
    ).catch(() => undefined);
    await providerReceived;

    const workerExit = once(dispatchWorker.child, 'exit');
    dispatchWorker.child.kill('SIGKILL');
    await workerExit;
    dispatchWorker = undefined;
    await customerRequest;

    const attempt = await pool.query<{
      attempt_id: string;
      operation: string;
      outcome: string | null;
      unknown_after: Date;
      stored: Record<string, unknown>;
    }>(
      `SELECT attempt_id, operation, outcome, unknown_after,
              row_to_json(dispatch_attempts) AS stored
       FROM dispatch_attempts WHERE request_id = $1`,
      [requestId],
    );
    expect(attempt.rows).toHaveLength(1);
    expect(attempt.rows[0]).toMatchObject({
      operation: 'writing.task1.grade',
      outcome: null,
    });
    expect(JSON.stringify(attempt.rows[0]?.stored)).not.toContain(ESSAY_MARKER);
    expect(
      await pool.query('SELECT 1 FROM usage_records WHERE request_id = $1', [
        requestId,
      ]),
    ).toMatchObject({ rowCount: 0 });
    expect(
      await redis.get(
        `aihub:v1:quota:${organizationId}:${monthKey(new Date())}`,
      ),
    ).toBeNull();

    metricsWorker = await startWorker('metrics', {
      requestId,
      organizationId,
      downstreamUrl: providerUrl,
    });
    const deadlineAt = attempt.rows[0]!.unknown_after.getTime();
    if (deadlineAt > Date.now()) {
      await new Promise((resolve) =>
        setTimeout(resolve, deadlineAt - Date.now() + 20),
      );
    }
    const metrics = await fetch(`${metricsWorker.url}/metrics`).then(
      (response) => response.text(),
    );
    expect(metrics).toContain(
      'aihub_dispatch_attempts_unresolved{operation="writing.task1.grade"} 1',
    );
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
