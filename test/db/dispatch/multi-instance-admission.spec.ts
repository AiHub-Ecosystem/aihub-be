import { readFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { join } from 'node:path';

import { ulid } from 'ulid';

import {
  createSandboxTestPool,
  createSandboxTestRedis,
  createTestPool,
} from '../shared/database';
import {
  type GradingOrganization,
  type HttpAnswer,
  type TestWorker,
  WRITING_TASK1_PATH,
  deleteGradingOrganization,
  listen,
  seedGradingOrganization,
  sendRequest,
  startWorker,
} from './app-worker';

const GRADE_RESPONSE = readFileSync(
  join(process.cwd(), 'test/fixtures/ai-writing/grade-task1.response.json'),
);
const GRADE_BODY = {
  question: 'Describe the chart.',
  chart_type: 'Bar Chart',
  essay: 'A clear essay about the chart.',
  image_url: 'https://example.com/chart.png',
};

function createProvider(onCall: () => void): Server {
  return createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      onCall();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(GRADE_RESPONSE);
    });
  });
}

function grade(
  worker: TestWorker,
  organization: GradingOrganization,
  idempotencyKey: string,
  host = 'api.production.test',
): Promise<HttpAnswer | undefined> {
  return sendRequest(worker.url, {
    path: WRITING_TASK1_PATH,
    headers: {
      host,
      'x-api-key': organization.apiKey.raw,
      'x-user-identity': organization.assertion,
      'idempotency-key': idempotencyKey,
    },
    body: GRADE_BODY,
  });
}

describe('multi-instance grading admission', () => {
  const pool = createTestPool();
  const sandboxPool = createSandboxTestPool();
  const redis = createSandboxTestRedis();
  let provider: Server | undefined;
  let workers: TestWorker[] = [];
  let organizations: GradingOrganization[] = [];
  let sandboxSeedPrefix: string | undefined;

  afterEach(async () => {
    await Promise.all(workers.map((worker) => worker.stop()));
    workers = [];
    if (provider !== undefined) {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider?.close(() => resolve()));
      provider = undefined;
    }
    for (const organization of organizations) {
      await sandboxPool.query(
        'DELETE FROM usage_records WHERE organization_id = $1',
        [organization.organizationId],
      );
      await sandboxPool.query(
        'DELETE FROM idempotency_records WHERE organization_id = $1',
        [organization.organizationId],
      );
      await sandboxPool.query(
        'DELETE FROM sandbox_dispatch_reservations WHERE organization_id = $1',
        [organization.organizationId],
      );
      await sandboxPool.query(
        'DELETE FROM sandbox_allowance_overrides WHERE organization_id = $1',
        [organization.organizationId],
      );
      await deleteGradingOrganization(pool, organization.organizationId);
    }
    organizations = [];
    if (sandboxSeedPrefix !== undefined) {
      await sandboxPool.query(
        'DELETE FROM sandbox_dispatch_reservations WHERE request_id LIKE $1',
        [`${sandboxSeedPrefix}%`],
      );
      sandboxSeedPrefix = undefined;
    }
  });

  afterAll(async () => {
    redis.disconnect();
    await pool.end();
    await sandboxPool.end();
  });

  it('shares the key limit and completed replay across two app processes', async () => {
    let downstreamCalls = 0;
    provider = createProvider(() => {
      downstreamCalls += 1;
    });
    const downstreamUrl = await listen(provider);
    workers = await Promise.all([
      startWorker({ downstreamUrl }),
      startWorker({ downstreamUrl }),
    ]);
    const organization = await seedGradingOrganization(pool, {
      label: 'multi_instance',
      maxConcurrent: 20,
      monthlyQuota: 20,
      hardStop: true,
    });
    organizations.push(organization);
    await pool.query(
      'UPDATE organizations SET rate_limit_rpm = 4 WHERE id = $1',
      [organization.organizationId],
    );

    const limited = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        grade(
          workers[index % workers.length]!,
          organization!,
          `shared-limit-${ulid()}`,
        ),
      ),
    );

    expect(limited.filter((answer) => answer?.status === 200)).toHaveLength(4);
    expect(limited.filter((answer) => answer?.status === 429)).toHaveLength(4);
    expect(downstreamCalls).toBe(4);

    await pool.query(
      'UPDATE organizations SET rate_limit_rpm = 600 WHERE id = $1',
      [organization.organizationId],
    );
    const replayKey = `shared-replay-${ulid()}`;
    const first = await grade(workers[0]!, organization, replayKey);
    const replay = await grade(workers[1]!, organization, replayKey);
    const refusedReplay = await grade(workers[0]!, organization, replayKey);

    expect(first?.status).toBe(200);
    expect(replay?.status).toBe(200);
    expect(refusedReplay?.status).toBe(429);
    expect(refusedReplay?.body).toMatch(/"code"\s*:\s*"RATE_LIMITED"/);
    expect(downstreamCalls).toBe(5);
    await expect(
      pool.query<{ total: number }>(
        `SELECT COALESCE(sum(billable_requests), 0)::int AS total
         FROM usage_records WHERE organization_id = $1`,
        [organization.organizationId],
      ),
    ).resolves.toMatchObject({ rows: [{ total: 5 }] });
  }, 120_000);

  it('shares the Organization allowance and 500-dispatch Sandbox ceiling across two processes', async () => {
    let downstreamCalls = 0;
    provider = createProvider(() => {
      downstreamCalls += 1;
    });
    const downstreamUrl = await listen(provider);
    workers = await Promise.all([
      startWorker({ downstreamUrl, runtimeDatabaseScope: 'sandbox' }),
      startWorker({ downstreamUrl, runtimeDatabaseScope: 'sandbox' }),
    ]);

    const organization = await seedGradingOrganization(pool, {
      label: 'sandbox_multi_org',
      maxConcurrent: 20,
      monthlyQuota: 20,
      hardStop: true,
    });
    organizations.push(organization);
    await pool.query(
      "UPDATE api_keys SET allowed_environments = ARRAY['sandbox'] WHERE id = $1",
      [organization.apiKey.id],
    );
    await sandboxPool.query(
      `INSERT INTO sandbox_allowance_overrides (organization_id, month_start, allowance)
       VALUES ($1, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 1)`,
      [organization.organizationId],
    );

    const contenders = Array.from({ length: 4 }, (_, index) => ({
      worker: workers[index % workers.length]!,
      key: `sandbox-org-cap-${ulid()}`,
    }));
    const responses = await Promise.all(
      contenders.map(({ worker, key }) =>
        grade(worker, organization, key, 'api.sandbox.test'),
      ),
    );
    const admittedIndex = responses.findIndex(
      (answer) => answer?.status === 200,
    );
    expect(admittedIndex).toBeGreaterThanOrEqual(0);
    expect(responses.filter((answer) => answer?.status === 429)).toHaveLength(
      3,
    );
    expect(downstreamCalls).toBe(1);

    const replay = await grade(
      workers[1 - (admittedIndex % 2)]!,
      organization,
      contenders[admittedIndex]!.key,
      'api.sandbox.test',
    );
    expect(replay?.status).toBe(200);
    expect(downstreamCalls).toBe(1);
    await expect(
      sandboxPool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM sandbox_dispatch_reservations
         WHERE organization_id = $1 AND status = 'reserved'`,
        [organization.organizationId],
      ),
    ).resolves.toMatchObject({ rows: [{ total: 1 }] });

    const globalOrganization = await seedGradingOrganization(pool, {
      label: 'sandbox_multi_global',
      maxConcurrent: 20,
      monthlyQuota: 20,
      hardStop: true,
    });
    organizations.push(globalOrganization);
    await pool.query(
      "UPDATE api_keys SET allowed_environments = ARRAY['sandbox'] WHERE id = $1",
      [globalOrganization.apiKey.id],
    );
    await sandboxPool.query(
      `INSERT INTO sandbox_allowance_overrides (organization_id, month_start, allowance)
       VALUES ($1, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 10)`,
      [globalOrganization.organizationId],
    );
    const reserved = await sandboxPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM sandbox_dispatch_reservations
       WHERE month_start = date_trunc('month', now() AT TIME ZONE 'UTC')::date
         AND status = 'reserved'`,
    );
    const seedCount = 499 - reserved.rows[0]!.count;
    expect(seedCount).toBeGreaterThanOrEqual(0);
    sandboxSeedPrefix = `multi-seed-${ulid()}-`;
    await sandboxPool.query(
      `INSERT INTO sandbox_dispatch_reservations
         (request_id, organization_id, month_start)
       SELECT $1 || n, 'org_multi_seed_' || n,
         date_trunc('month', now() AT TIME ZONE 'UTC')::date
       FROM generate_series(1, $2) AS n`,
      [sandboxSeedPrefix, seedCount],
    );

    const globalResponses = await Promise.all(
      workers.map((worker) =>
        grade(
          worker,
          globalOrganization,
          `sandbox-global-cap-${ulid()}`,
          'api.sandbox.test',
        ),
      ),
    );
    expect(
      globalResponses.filter((answer) => answer?.status === 200),
    ).toHaveLength(1);
    expect(
      globalResponses.filter((answer) => answer?.status === 429),
    ).toHaveLength(1);
    expect(downstreamCalls).toBe(2);
    await expect(
      sandboxPool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM sandbox_dispatch_reservations
         WHERE month_start = date_trunc('month', now() AT TIME ZONE 'UTC')::date
           AND status = 'reserved'`,
      ),
    ).resolves.toMatchObject({ rows: [{ total: 500 }] });
  }, 120_000);
});
