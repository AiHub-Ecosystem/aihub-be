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

async function waitForPublishedLevel(redis: Redis): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const level = await redis.get(SHEDDING_LEVEL_KEY);
    if (level === '1' || level === '2') return level;
    // real-timer-ok: the level arrives over Redis from another OS process
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('no instance published a shedding level within 30 s');
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

describe('multi-instance prioritized load shedding', () => {
  const pool = createTestPool();
  const redis = createSandboxTestRedis();
  let provider: Server | undefined;
  let workers: TestWorker[] = [];
  let organization: GradingOrganization | undefined;

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

    // The same path admits while the host is healthy, so a later 503 is the
    // shedding decision rather than a broken worker.
    const admittedBeforeFlood = await grade(saturated, seeded);
    expect(admittedBeforeFlood?.status).toBe(200);

    const flood = Array.from({ length: FLOOD }, () => grade(saturated, seeded));
    flood.forEach((call) => void call.catch(() => undefined));

    await expect(waitForPublishedLevel(redis)).resolves.toMatch(/^[12]$/);

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

    for (const answer of [await login(peer), await login(saturated)]) {
      // Unknown credentials answer 401, not 503: the tier guard let them in.
      expect(answer).toBeDefined();
      expect(answer?.status).toBe(401);
      expect(answer?.body).not.toContain('SERVICE_OVERLOADED');
    }
  }, 180_000);
});
