import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import process from 'node:process';

const fixtureRoot = process.env.BENCHMARK_FIXTURE_ROOT ?? '/fixtures';
const redisTarget = process.env.BENCHMARK_REDIS_TARGET ?? 'redis:6379';
const oneWayDelayMs = Number(
  process.env.BENCHMARK_REDIS_ONE_WAY_DELAY_MS ?? '30',
);
const stubLatencyMs = Number(process.env.BENCHMARK_STUB_LATENCY_MS ?? '2000');
const stubErrorRate = Number(process.env.BENCHMARK_STUB_ERROR_RATE ?? '0');

if (
  !Number.isInteger(oneWayDelayMs) ||
  oneWayDelayMs < 0 ||
  !Number.isInteger(stubLatencyMs) ||
  stubLatencyMs < 0 ||
  !Number.isFinite(stubErrorRate) ||
  stubErrorRate < 0 ||
  stubErrorRate > 1
) {
  throw new Error('invalid capacity benchmark latency or error-rate setting');
}

const fixtures = new Map([
  [
    '/grading-feedback-task1',
    await readFile(`${fixtureRoot}/ai-writing/grade-task1.response.json`),
  ],
  [
    '/grading-feedback-task2',
    await readFile(`${fixtureRoot}/ai-writing/grade-task2.response.json`),
  ],
  [
    '/api/v1/speaking/grading',
    await readFile(`${fixtureRoot}/ai-speaking/grading.response.json`),
  ],
  [
    '/api/v1/speaking/grading-json',
    await readFile(`${fixtureRoot}/ai-speaking/grading.response.json`),
  ],
]);

const requests = new Map();
const errors = new Map();
function handleStubRequest(request, response) {
  if (request.method === 'GET' && request.url === '/__health') {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
    return;
  }
  if (request.method === 'GET' && request.url === '/__stats') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        requests: Object.fromEntries(requests),
        errors: Object.fromEntries(errors),
        redisOneWayDelayMs: oneWayDelayMs,
        redisRoundTripDelayMs: oneWayDelayMs * 2,
        stubLatencyMs,
        stubErrorRate,
      }),
    );
    return;
  }
  if (request.method === 'POST' && request.url === '/__stats/reset') {
    requests.clear();
    errors.clear();
    request.resume();
    response.writeHead(204).end();
    return;
  }

  const fixture = fixtures.get(request.url ?? '');
  if (request.method !== 'POST' || fixture === undefined) {
    request.resume();
    response.writeHead(404).end();
    return;
  }

  const route = request.url;
  const requestCount = (requests.get(route) ?? 0) + 1;
  requests.set(route, requestCount);
  request.on('end', () => {
    setTimeout(() => {
      const errorCount = errors.get(route) ?? 0;
      const shouldFail = Math.floor(requestCount * stubErrorRate) > errorCount;
      if (shouldFail) {
        errors.set(route, errorCount + 1);
        response.writeHead(503, {
          'content-type': 'application/json',
          'x-benchmark-stub-error': 'true',
        });
        response.end('{"detail":"controlled benchmark stub failure"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(fixture);
    }, stubLatencyMs);
  });
  request.resume();
}

// Production reaches AI Writing and AI Speaking at separate origins, and the
// gateway keeps one connection pool per origin, so each service gets a port.
const writingServer = createHttpServer(handleStubRequest);
const speakingServer = createHttpServer(handleStubRequest);
writingServer.listen(8080, '0.0.0.0');
speakingServer.listen(8081, '0.0.0.0');

// Delay every chunk by the same one-way latency without holding back the chunks
// behind it, like a link delay. Pausing the source per chunk serialized the
// stream and stretched the configured 60 ms round trip to as much as 120 ms.
// Equal-delay timers fire in insertion order, so byte order is kept; the source
// pauses only when the destination applies backpressure.
function forwardDelayed(source, destination) {
  source.on('data', (chunk) => {
    setTimeout(() => {
      if (destination.destroyed) return;
      if (!destination.write(chunk) && !source.isPaused()) {
        source.pause();
        destination.once('drain', () => source.resume());
      }
    }, oneWayDelayMs);
  });
  source.on('end', () => {
    setTimeout(() => destination.end(), oneWayDelayMs);
  });
  source.on('error', () => destination.destroy());
}

const redisServer = createTcpServer((client) => {
  const [host, portText] = redisTarget.split(':');
  const upstream = connect(Number(portText), host);
  // ioredis disables Nagle on its socket. Without the same here, a command
  // longer than one TCP segment (the retry-budget EVAL) waits a delayed ACK,
  // about 40 ms, that the real link does not add.
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  forwardDelayed(client, upstream);
  forwardDelayed(upstream, client);
});

redisServer.listen(6379, '0.0.0.0');

async function close() {
  await Promise.all([
    new Promise((resolve) => writingServer.close(resolve)),
    new Promise((resolve) => speakingServer.close(resolve)),
    new Promise((resolve) => redisServer.close(resolve)),
  ]);
}

process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
