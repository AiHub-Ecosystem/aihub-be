import { ulid } from 'ulid';

import {
  type HttpAnswer,
  type TestWorker,
  sendRequest,
  startWorker,
} from '../dispatch/app-worker';
import { sandboxTestRedisUrl } from '../shared/database';
import { TcpFaultProxy } from '../tenant-isolation/fault-injection/tcp-fault-proxy';

// Scenario 3 of #328 (2026-10-09): hang the Redis the auth rate limiters use
// and assert that login, refresh, and registration still answer within a
// stated bound, and that the sockets and memory they hold do not accumulate.
const AUTH_BOUND_MS = 2_000;
const ROUNDS = 5;
const MAX_REDIS_CONNECTIONS = 6;

async function timedCall(
  run: () => Promise<HttpAnswer | undefined>,
): Promise<{ readonly answer: HttpAnswer | undefined; readonly ms: number }> {
  const startedAt = performance.now();
  const answer = await run();
  return { answer, ms: performance.now() - startedAt };
}

async function residentMemory(worker: TestWorker): Promise<number> {
  const metrics = await fetch(`${worker.url}/metrics`).then((response) =>
    response.text(),
  );
  const line = metrics
    .split('\n')
    .find((candidate) =>
      candidate.startsWith('aihub_process_resident_memory_bytes '),
    );
  return Number(line?.split(' ').at(-1));
}

describe('auth routes while their Redis hangs', () => {
  let proxy: TcpFaultProxy | undefined;
  let worker: TestWorker | undefined;

  afterEach(async () => {
    await proxy?.setMode('normal');
    await worker?.stop();
    await proxy?.close();
    worker = undefined;
    proxy = undefined;
  });

  it('answers login, refresh, and registration inside the bound without accumulating sockets or memory', async () => {
    const target = new URL(sandboxTestRedisUrl());
    proxy = new TcpFaultProxy({
      host: target.hostname === 'localhost' ? '127.0.0.1' : target.hostname,
      port: Number(target.port || 6379),
    });
    const proxyPort = await proxy.listen();
    worker = await startWorker({
      // No grading runs here, so the AI Service URL is never called.
      downstreamUrl: 'http://127.0.0.1:9',
      redisUrl: `redis://127.0.0.1:${proxyPort}${target.pathname}`,
    });
    const app = worker;

    // One login, refresh, and registration, each timed.
    const round = async () => [
      await timedCall(() =>
        sendRequest(app.url, {
          path: '/v1/auth/login',
          body: {
            email: `nobody-${ulid().toLowerCase()}@example.test`,
            password: 'Correct-horse-battery-9!',
          },
        }),
      ),
      await timedCall(() =>
        sendRequest(app.url, { path: '/v1/auth/refresh', body: {} }),
      ),
      await timedCall(() =>
        sendRequest(app.url, {
          path: '/v1/auth/register',
          body: {
            email: `fault-${ulid().toLowerCase()}@example.test`,
            username: `fault_${ulid().toLowerCase().slice(-12)}`,
            password: 'Correct-horse-battery-9!',
          },
        }),
      ),
    ];

    await proxy.setMode('hang');
    // Warm-up rounds let the first password hash allocate its 64 MiB Argon2
    // buffer and every lazily connected Redis client open its connection;
    // only what accumulates per request afterwards counts.
    const calls = [...(await round()), ...(await round())];
    const memoryAfterWarmUp = await residentMemory(app);
    let peakSockets = proxy.openConnectionCount();
    const sampler = setInterval(() => {
      peakSockets = Math.max(peakSockets, proxy?.openConnectionCount() ?? 0);
    }, 10);
    try {
      for (let index = 0; index < ROUNDS; index += 1) {
        calls.push(...(await round()));
      }
    } finally {
      clearInterval(sampler);
    }
    // Every call gets an answer that is not a server failure, in bound.
    expect(calls.every(({ answer }) => answer !== undefined)).toBe(true);
    expect(
      calls
        .map(({ answer }, index) => ({
          route: ['login', 'refresh', 'register'][index % 3],
          status: answer?.status ?? 599,
        }))
        .filter(({ status }) => status >= 500),
    ).toEqual([]);
    expect(Math.max(...calls.map(({ ms }) => ms))).toBeLessThan(AUTH_BOUND_MS);
    // A client may replace a timed-out connection, but the app keeps a fixed
    // handful of Redis clients; a socket per request would pass this after
    // the first round of the 21 requests.
    expect(peakSockets).toBeLessThanOrEqual(MAX_REDIS_CONNECTIONS);
    // Ten more hashes held per request would add 640 MiB; less than one
    // buffer of growth means nothing accumulates.
    expect((await residentMemory(app)) - memoryAfterWarmUp).toBeLessThan(
      64 * 1024 ** 2,
    );
  }, 120_000);
});
