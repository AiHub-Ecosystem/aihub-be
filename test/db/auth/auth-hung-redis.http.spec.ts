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

    await proxy.setMode('hang');
    const memoryBefore = await residentMemory(app);
    const socketsAtHang = proxy.openConnectionCount();

    const calls = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      calls.push(
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
      );
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
    // The hung Redis connections are reused, not multiplied per request.
    expect(proxy.openConnectionCount()).toBeLessThanOrEqual(socketsAtHang);
    expect((await residentMemory(app)) - memoryBefore).toBeLessThan(
      64 * 1024 ** 2,
    );
  }, 120_000);
});
