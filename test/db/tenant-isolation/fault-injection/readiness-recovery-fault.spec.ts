import { type TestWorker, startWorker } from '../../dispatch/app-worker';

import { postgresThroughProxy, redisThroughProxy } from './fault-targets';
import type { FaultMode, TcpFaultProxy } from './tcp-fault-proxy';

// The readiness probe gives each dependency 1 s, so one /ready answer is
// bounded a little above that.
const READY_ANSWER_BOUND_MS = 2_000;
// ponytail: provisional same-process recovery bound. #749 (PostgreSQL
// keep-alive and connection rotation) and #645 (Redis late commands) own the
// numbers; tighten this to their bounds when they land.
const RECOVERY_BOUND_MS = 10_000;
// Delay per forwarded chunk for "slow but inside the bounds".
const INSIDE_BOUND_SLOW_MS = 50;

type Dependency = 'postgres' | 'redis';

interface Readiness {
  readonly status: number;
  readonly dependencies: Readonly<Record<string, 'up' | 'down'>>;
  readonly ms: number;
}

async function readiness(worker: TestWorker): Promise<Readiness> {
  const startedAt = performance.now();
  const response = await fetch(`${worker.url}/ready`);
  const body = (await response.json()) as Pick<Readiness, 'dependencies'>;
  return {
    status: response.status,
    dependencies: body.dependencies,
    ms: performance.now() - startedAt,
  };
}

async function health(worker: TestWorker): Promise<number> {
  return (await fetch(`${worker.url}/health`)).status;
}

/** Polls /ready until `accept` holds, or fails with the last answer. */
async function readinessUntil(
  worker: TestWorker,
  accept: (answer: Readiness) => boolean,
  timeoutMs: number,
): Promise<Readiness & { readonly waitedMs: number }> {
  const startedAt = performance.now();
  let last: Readiness | undefined;
  while (performance.now() - startedAt < timeoutMs) {
    last = await readiness(worker);
    if (accept(last)) {
      return { ...last, waitedMs: performance.now() - startedAt };
    }
    // real-timer-ok: the fault-injection lane polls a real app process for dependency recovery
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`/ready never matched; last answer ${JSON.stringify(last)}`);
}

function stillRunning(worker: TestWorker, pid: number | undefined): boolean {
  return (
    worker.child.pid === pid &&
    worker.child.exitCode === null &&
    worker.child.signalCode === null
  );
}

function probeName(dependency: Dependency): string {
  return dependency === 'redis' ? 'redis' : 'runtime-postgres';
}

describe('readiness through dependency faults in one app process', () => {
  let postgres: TcpFaultProxy;
  let redis: TcpFaultProxy;
  let databaseUrl: string;
  let redisUrl: string;
  let worker: TestWorker | undefined;

  beforeAll(async () => {
    const postgresTarget = await postgresThroughProxy(INSIDE_BOUND_SLOW_MS);
    const redisTarget = await redisThroughProxy(INSIDE_BOUND_SLOW_MS);
    postgres = postgresTarget.proxy;
    redis = redisTarget.proxy;
    databaseUrl = postgresTarget.url;
    redisUrl = redisTarget.url;
  });

  afterEach(async () => {
    await postgres.setMode('normal');
    await redis.setMode('normal');
    await worker?.stop();
    worker = undefined;
  });

  afterAll(async () => {
    await postgres.close();
    await redis.close();
  });

  function proxyFor(dependency: Dependency): TcpFaultProxy {
    return dependency === 'redis' ? redis : postgres;
  }

  async function start(): Promise<TestWorker> {
    // No grading runs here, so the AI Service URL is never called.
    worker = await startWorker({
      downstreamUrl: 'http://127.0.0.1:9',
      databaseUrl,
      redisUrl,
    });
    return worker;
  }

  it('turns ready only after PostgreSQL and Redis come up after startup', async () => {
    await postgres.setMode('refuse');
    await redis.setMode('refuse');
    const app = await start();
    const pid = app.child.pid;

    const down = await readiness(app);
    expect(down.status).toBe(503);
    expect(down.ms).toBeLessThan(READY_ANSWER_BOUND_MS);
    expect(down.dependencies).toMatchObject({
      'runtime-postgres': 'down',
      redis: 'down',
    });
    expect(await health(app)).toBe(200);

    await postgres.setMode('normal');
    await redis.setMode('normal');
    const up = await readinessUntil(
      app,
      ({ status }) => status === 200,
      RECOVERY_BOUND_MS,
    );

    expect(up.dependencies).toEqual({ 'runtime-postgres': 'up', redis: 'up' });
    expect(stillRunning(app, pid)).toBe(true);
  }, 150_000);

  describe.each<[Dependency, FaultMode]>([
    ['postgres', 'refuse'],
    ['postgres', 'hang'],
    ['redis', 'refuse'],
    ['redis', 'hang'],
  ])('while %s is %s', (dependency, mode) => {
    it('answers /ready 503 inside the bound, keeps /health, and recovers without a restart', async () => {
      const app = await start();
      const pid = app.child.pid;
      await readinessUntil(
        app,
        ({ status }) => status === 200,
        RECOVERY_BOUND_MS,
      );

      await proxyFor(dependency).setMode(mode);
      const down = await readinessUntil(
        app,
        ({ status }) => status === 503,
        READY_ANSWER_BOUND_MS * 2,
      );

      expect(down.ms).toBeLessThan(READY_ANSWER_BOUND_MS);
      expect(down.dependencies[probeName(dependency)]).toBe('down');
      expect(await health(app)).toBe(200);

      await proxyFor(dependency).setMode('normal');
      const up = await readinessUntil(
        app,
        ({ status }) => status === 200,
        RECOVERY_BOUND_MS,
      );

      expect(up.dependencies).toEqual({
        'runtime-postgres': 'up',
        redis: 'up',
      });
      expect(stillRunning(app, pid)).toBe(true);
    }, 150_000);
  });

  it.each<Dependency>(['postgres', 'redis'])(
    'stays ready while %s is slow inside its bounds',
    async (dependency) => {
      const app = await start();
      await readinessUntil(
        app,
        ({ status }) => status === 200,
        RECOVERY_BOUND_MS,
      );

      await proxyFor(dependency).setMode('slow');
      const slow = await readiness(app);

      expect(slow.status).toBe(200);
      expect(slow.ms).toBeLessThan(READY_ANSWER_BOUND_MS);
    },
    150_000,
  );
});
