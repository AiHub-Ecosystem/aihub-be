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

/** Green-only evidence: the call returns as soon as a real 503 arrives. */
async function eventuallyShed(
  worker: TestWorker,
  organization: GradingOrganization,
): Promise<HttpAnswer | undefined> {
  const deadline = Date.now() + 15_000;
  let last: HttpAnswer | undefined;
  while (Date.now() < deadline) {
    last = await grade(worker, organization);
    if (last?.status === 503) return last;
    // real-timer-ok: each retry is a real HTTP request to the peer process
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
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

    const flood = Array.from({ length: FLOOD }, () => grade(saturated, seeded));
    flood.forEach((call) => void call.catch(() => undefined));

    await expect(waitForPublishedLevel(redis)).resolves.toMatch(/^[12]$/);

    // The peer is idle, so its own policy stays at zero: a refusal it makes
    // proves the level arrived through the shared store.
    const peerShed = await eventuallyShed(peer, seeded);
    expect(peerShed?.status).toBe(503);
    expect(peerShed?.body).toContain('"SERVICE_OVERLOADED"');
    expect(peerShed?.body).toMatch(/"retry_after_ms":\d+/);

    const saturatedShed = await eventuallyShed(saturated, seeded);
    expect(saturatedShed?.status).toBe(503);
    expect(saturatedShed?.body).toContain('"SERVICE_OVERLOADED"');

    for (const answer of [await login(peer), await login(saturated)]) {
      expect(answer?.status).not.toBe(503);
      expect(answer?.body).not.toContain('SERVICE_OVERLOADED');
    }
  }, 180_000);
});
