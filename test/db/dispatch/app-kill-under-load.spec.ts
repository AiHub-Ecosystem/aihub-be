import { readFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { join } from 'node:path';

import { ulid } from 'ulid';

import { createSandboxTestRedis, createTestPool } from '../shared/database';
import {
  type GradingOrganization,
  type HttpAnswer,
  type TestWorker,
  WRITING_TASK1_PATH,
  deleteGradingOrganization,
  killWorker,
  listen,
  seedGradingOrganization,
  sendRequest,
  startWorker,
} from './app-worker';

// Scenario 2 of #328 (2026-10-09): kill the app while many gradings are in
// flight, then let the clients retry, and assert what each side sees.
const IN_FLIGHT = 8;
const MAX_CONCURRENT = 20;
const GRADE_RESPONSE = readFileSync(
  join(process.cwd(), 'test/fixtures/ai-writing/grade-task1.response.json'),
);

function grade(
  worker: TestWorker,
  organization: GradingOrganization,
  idempotencyKey: string,
): Promise<HttpAnswer | undefined> {
  return sendRequest(worker.url, {
    path: WRITING_TASK1_PATH,
    headers: {
      'x-api-key': organization.apiKey.raw,
      'x-user-identity': organization.assertion,
      'idempotency-key': idempotencyKey,
    },
    body: {
      question: 'Describe the chart.',
      chart_type: 'Bar Chart',
      essay: 'A clear essay about the chart.',
      image_url: 'https://example.com/chart.png',
    },
  });
}

function errorCode(answer: HttpAnswer | undefined): string {
  if (answer === undefined) return 'connection_broken';
  if (answer.status < 400) return String(answer.status);
  return `${answer.status} ${(JSON.parse(answer.body) as { error?: { code?: string } }).error?.code}`;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('an app process killed under grading load', () => {
  const pool = createTestPool();
  const redis = createSandboxTestRedis();
  let organization: GradingOrganization | undefined;
  let worker: TestWorker | undefined;
  let stalledProvider: Server | undefined;
  let healthyProvider: Server | undefined;

  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    await closeServer(stalledProvider);
    await closeServer(healthyProvider);
    if (organization !== undefined) {
      await redis.del(`aihub:v1:inflight:${organization.organizationId}`);
      await deleteGradingOrganization(pool, organization.organizationId);
      organization = undefined;
    }
  });

  afterAll(async () => {
    redis.disconnect();
    await pool.end();
  });

  it('leaves pending records and held permits but no usage, and the restarted process absorbs the retry wave', async () => {
    organization = await seedGradingOrganization(pool, {
      label: 'app_kill',
      maxConcurrent: MAX_CONCURRENT,
      monthlyQuota: 1_000,
      hardStop: false,
    });
    const tenant = organization;
    let received = 0;
    stalledProvider = createServer((request) => {
      request.resume();
      request.once('end', () => {
        received += 1;
      });
    });
    worker = await startWorker({
      downstreamUrl: await listen(stalledProvider),
    });
    const keys = Array.from({ length: IN_FLIGHT }, () => `kill-${ulid()}`);
    const killed = keys.map((key) => grade(worker as TestWorker, tenant, key));

    const deadline = Date.now() + 20_000;
    while (received < IN_FLIGHT && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(received).toBe(IN_FLIGHT);
    await killWorker(worker);
    worker = undefined;

    // The callers lose their connections; nobody was answered.
    expect(new Set((await Promise.all(killed)).map(errorCode))).toEqual(
      new Set(['connection_broken']),
    );
    // Each Writing request left its idempotency record pending (#285, #317).
    const pending = await pool.query<{ state: string }>(
      'SELECT state FROM idempotency_records WHERE organization_id = $1',
      [tenant.organizationId],
    );
    expect(pending.rows).toHaveLength(IN_FLIGHT);
    expect(new Set(pending.rows.map(({ state }) => state)).size).toBe(1);
    expect(pending.rows[0]?.state).not.toBe('completed');
    // Their permits stay held in Redis until the 120 s stale prune (#423).
    expect(
      await redis.zcard(`aihub:v1:inflight:${tenant.organizationId}`),
    ).toBe(IN_FLIGHT);
    // Dispatched work that never answered records no usage (#477).
    expect(
      (
        await pool.query(
          'SELECT 1 FROM usage_records WHERE organization_id = $1',
          [tenant.organizationId],
        )
      ).rowCount,
    ).toBe(0);

    let gradedAfterRestart = 0;
    healthyProvider = createServer((request, response) => {
      request.resume();
      request.once('end', () => {
        gradedAfterRestart += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(GRADE_RESPONSE);
      });
    });
    worker = await startWorker({
      downstreamUrl: await listen(healthyProvider),
    });
    const restarted = worker;
    const freshKeys = Array.from(
      { length: IN_FLIGHT },
      () => `fresh-${ulid()}`,
    );

    // The retry wave: every killed request retries with its key, alongside
    // new work. The stale permits leave 12 of 20 free for it.
    const [retries, fresh] = await Promise.all([
      Promise.all(keys.map((key) => grade(restarted, tenant, key))),
      Promise.all(freshKeys.map((key) => grade(restarted, tenant, key))),
    ]);

    expect(restarted.child.exitCode).toBeNull();
    expect(restarted.child.signalCode).toBeNull();
    expect(new Set(fresh.map(errorCode))).toEqual(new Set(['200']));
    // A retry of a request the dead process still owns is answered at once,
    // retryably, instead of dispatching a second grading: the record is
    // still in flight, or the Organization's same-key retry budget (ADR-0113)
    // refuses the storm.
    expect(
      retries
        .map(errorCode)
        .every((code) =>
          ['409 IDEMPOTENCY_CONFLICT', '429 RATE_LIMITED'].includes(code),
        ),
    ).toBe(true);
    expect(gradedAfterRestart).toBe(freshKeys.length);
    expect(
      await redis.zcard(`aihub:v1:inflight:${tenant.organizationId}`),
    ).toBe(IN_FLIGHT);
  }, 120_000);
});
