import { once } from 'node:events';
import { type Server, createServer } from 'node:http';

import type Redis from 'ioredis';
import { ulid } from 'ulid';

import { SHEDDING_LEVEL_KEY } from '@/modules/gateway/infrastructure/shedding-level.store';

import { createSandboxTestRedis, createTestPool } from '../shared/database';
import {
  type GradingOrganization,
  type HttpAnswer,
  type TestWorker,
  WRITING_TASK1_PATH,
  deleteGradingOrganization,
  listen,
  seedGradingOrganization,
  sendRequest,
  startTwoWorkers,
} from './app-worker';

// #1591: an instance that saturates must make its peers shed the same tier,
// while authentication keeps answering on both.
const FLOOD = 20;

/** Never answers, so the flood holds the adaptive limiter at its limit. */
function createStalledProvider(): Server {
  return createServer((request) => request.resume());
}

function grade(
  worker: TestWorker,
  organization: GradingOrganization,
): Promise<HttpAnswer | undefined> {
  return sendRequest(worker.url, {
    path: WRITING_TASK1_PATH,
    headers: {
      'x-api-key': organization.apiKey.raw,
      'x-user-identity': organization.assertion,
      'idempotency-key': `shed-${ulid()}`,
    },
    body: {
      question: 'Describe the chart.',
      chart_type: 'Bar Chart',
      essay: 'A clear essay about the chart.',
      image_url: 'https://example.com/chart.png',
    },
  });
}

async function waitForPublishedLevel(
  redis: Redis,
  saturated: TestWorker,
  floodSize: number,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const level = await redis.get(SHEDDING_LEVEL_KEY);
    if (level === '1' || level === '2') return level;
    // real-timer-ok: the level arrives over Redis from another OS process
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // The scrape is the only view of why nothing escalated: no dispatch in
  // flight reads exactly like a governor that never ran.
  const metrics = await scrape(saturated);
  const concurrency = metrics
    .split('\n')
    .filter((line) => line.startsWith('aihub_downstream_concurrency_limit'))
    .join('\n');
  throw new Error(
    [
      'no instance published a shedding level within 30 s',
      `redis ${SHEDDING_LEVEL_KEY}=${String(await redis.get(SHEDDING_LEVEL_KEY))}`,
      `flood in flight: ${String(floodSize)}`,
      concurrency === '' ? 'no concurrency sample' : concurrency,
      `applied level ${shedLevel(metrics)}`,
    ].join('\n'),
  );
}

/**
 * Green-only evidence: the call returns as soon as a real 503 arrives, and a
 * refusal is measured as a fast one — it never waits on Redis or on the body.
 */
async function eventuallyShed(
  worker: TestWorker,
  organization: GradingOrganization,
): Promise<{ answer: HttpAnswer | undefined; elapsedMs: number }> {
  const deadline = Date.now() + 15_000;
  let last: HttpAnswer | undefined;
  let elapsedMs = 0;
  while (Date.now() < deadline) {
    const startedAt = Date.now();
    last = await grade(worker, organization);
    if (last?.status === 503) {
      elapsedMs = Date.now() - startedAt;
      break;
    }
    // real-timer-ok: each retry is a real HTTP request to the peer process
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { answer: last, elapsedMs };
}

function login(worker: TestWorker): Promise<HttpAnswer | undefined> {
  return sendRequest(worker.url, {
    path: '/v1/auth/login',
    body: {
      email: `nobody-${ulid().toLowerCase()}@example.test`,
      password: 'Correct-horse-battery-9!',
    },
  });
}

/** The worker's own scrape: the only way to see what its gate admitted. */
async function scrape(worker: TestWorker): Promise<string> {
  const answer = await sendRequest(worker.url, {
    method: 'GET',
    path: '/metrics',
  });
  if (answer === undefined) throw new Error('worker did not answer /metrics');
  return answer.body;
}

function shedCount(
  metrics: string,
  tier: 'critical' | 'standard' | 'best-effort',
) {
  const match = new RegExp(
    `^aihub_shed_requests_total\\{tier="${tier}"\\} (\\d+)$`,
    'm',
  ).exec(metrics);
  if (match?.[1] === undefined) throw new Error(`no shed sample for ${tier}`);
  return Number(match[1]);
}

function shedLevel(metrics: string): number {
  const match = /^aihub_shed_level (\d+)$/m.exec(metrics);
  if (match?.[1] === undefined) throw new Error('no aihub_shed_level sample');
  return Number(match[1]);
}

/**
 * The governor adopts the shared level on its own one-second timer, so a peer
 * publishes before it applies. Waiting here keeps the next assertion about
 * shedding rather than about that timer's phase.
 */
async function waitForAppliedLevel(
  worker: TestWorker,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last = -1;
  while (Date.now() < deadline) {
    last = shedLevel(await scrape(worker));
    if (last >= expected) return;
    // real-timer-ok: the level arrives on the worker's own refresh timer
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`worker stayed at shed level ${last}, expected ${expected}`);
}

describe('multi-instance prioritized load shedding', () => {
  const pool = createTestPool();
  const redis = createSandboxTestRedis();
  let provider: Server | undefined;
  let workers: TestWorker[] = [];
  let organization: GradingOrganization | undefined;

  beforeAll(async () => {
    // The client refuses commands until it is connected, and this suite's first
    // act is a DEL, before any request has given it time to connect.
    if (redis.status !== 'ready') await once(redis, 'ready');
  });

  afterEach(async () => {
    await Promise.allSettled(workers.map((worker) => worker.stop()));
    workers = [];
    if (provider !== undefined) {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider?.close(() => resolve()));
      provider = undefined;
    }
    await redis.del(SHEDDING_LEVEL_KEY);
    if (organization !== undefined) {
      await deleteGradingOrganization(pool, organization.organizationId);
      organization = undefined;
    }
  });

  afterAll(async () => {
    redis.disconnect();
    await pool.end();
  });

  it('sheds grading on both processes while login still answers', async () => {
    await redis.del(SHEDDING_LEVEL_KEY);
    provider = createStalledProvider();
    const [saturated, peer] = await startTwoWorkers({
      downstreamUrl: await listen(provider),
    });
    workers = [saturated, peer];
    const seeded = await seedGradingOrganization(pool, {
      label: 'multi_instance_shedding',
      maxConcurrent: FLOOD * 2,
      monthlyQuota: 200,
      hardStop: true,
    });
    organization = seeded;

    // The stalled provider never answers, so no grading call can return 200.
    // What must hold before the flood is that the gate is quiet: level 0, and
    // not one refusal counted. Without this, a later 503 could be a worker that
    // never worked.
    const before = await scrape(saturated);
    expect(before).toContain('aihub_shed_level 0');
    expect(shedCount(before, 'best-effort')).toBe(0);

    const flood = Array.from({ length: FLOOD }, () => grade(saturated, seeded));
    flood.forEach((call) => void call.catch(() => undefined));

    await expect(
      waitForPublishedLevel(redis, saturated, FLOOD),
    ).resolves.toMatch(/^[12]$/);
    await waitForAppliedLevel(peer, 1);

    // The peer is idle, so its own policy stays at zero: a refusal it makes
    // proves the level arrived through the shared store.
    const peerShed = await eventuallyShed(peer, seeded);
    expect(peerShed.answer?.status).toBe(503);
    expect(peerShed.answer?.body).toContain('"SERVICE_OVERLOADED"');
    expect(peerShed.answer?.body).toMatch(/"retry_after_ms":\d+/);
    expect(peerShed.elapsedMs).toBeLessThan(1_000);

    const saturatedShed = await eventuallyShed(saturated, seeded);
    expect(saturatedShed.answer?.status).toBe(503);
    expect(saturatedShed.answer?.body).toContain('"SERVICE_OVERLOADED"');
    expect(saturatedShed.elapsedMs).toBeLessThan(1_000);

    // The refusals are counted by tier, and the idle peer counted its own.
    for (const worker of [saturated, peer]) {
      expect(shedCount(await scrape(worker), 'best-effort')).toBeGreaterThan(0);
      // A refusal that lands on a critical route would show up here.
      expect(shedCount(await scrape(worker), 'critical')).toBe(0);
    }

    for (const answer of [await login(peer), await login(saturated)]) {
      // Unknown credentials answer 401, not 503: the tier guard let them in.
      expect(answer).toBeDefined();
      expect(answer?.status).toBe(401);
      expect(answer?.body).not.toContain('SERVICE_OVERLOADED');
    }
  }, 180_000);
});
