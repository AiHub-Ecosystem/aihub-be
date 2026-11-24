import { once } from 'node:events';
import { type Server, createServer } from 'node:http';

import { generateRequestId } from '@/common/request-context/request-id';
import { HttpLegacyContentClient } from '@/modules/content-proxy/infrastructure/http-legacy-content.client';

import { rejection, timed } from '../../../support/fault-timing';
import { TcpFaultProxy } from '../../../support/tcp-fault-proxy';

// It needs no database, but stays in this Jest-on-Node lane: under the unit
// lane's Bun runner the client would use Bun's fetch, not the undici fetch
// production runs, and the hung-backend case then fails with a connection
// error instead of the timeout.
// The legacy content backend row of the #2019 matrix. #1949 owns any change
// to this mapping; these cases pin the current one.
// The client's fixed fetch timeout (DEFAULT_TIMEOUT_MS in the client).
const LEGACY_TIMEOUT_MS = 10_000;
const TIMEOUT_SLACK_MS = 1_000;
// A refused connection is answered without waiting on the timeout.
const REFUSAL_BOUND_MS = 1_000;

let stub: Server;
let proxy: TcpFaultProxy;
let client: HttpLegacyContentClient;
let answer: { readonly status: number; readonly body: string } = {
  status: 200,
  body: '[]',
};

function templates(): Promise<unknown> {
  return client.fetchWritingTask1Templates(10, 1, generateRequestId());
}

beforeAll(async () => {
  stub = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body);
    });
  });
  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');
  const address = stub.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Legacy content stub did not bind');
  }
  proxy = new TcpFaultProxy({ host: '127.0.0.1', port: address.port });
  client = new HttpLegacyContentClient(
    `http://127.0.0.1:${await proxy.listen()}`,
    // undici's fetch, loaded inside Jest's module realm, cannot see Node's
    // Symbol.dispose and throws "removeAbortListener is not a function" once a
    // fetch settles. Node's own fetch is the same WHATWG API from the host
    // realm; the status and body mapping under test is the client's.
    fetch as unknown as ConstructorParameters<
      typeof HttpLegacyContentClient
    >[1],
  );
});

afterEach(async () => {
  answer = { status: 200, body: '[]' };
  await proxy.setMode('normal');
});

afterAll(async () => {
  await proxy.close();
  stub.closeAllConnections();
  stub.close();
});

describe('legacy content backend faults', () => {
  it('answers a refused connection at once with a retryable 503 AI_SERVICE_UNAVAILABLE', async () => {
    await proxy.setMode('refuse');
    const call = await timed(templates);

    expect(rejection(call.result)).toMatchObject({
      code: 'AI_SERVICE_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
    expect(call.ms).toBeLessThan(REFUSAL_BOUND_MS);
  });

  it('answers a hung backend with a retryable 504 AI_SERVICE_TIMEOUT at its 10 s timeout', async () => {
    await proxy.setMode('hang');
    const call = await timed(templates);

    expect(rejection(call.result)).toMatchObject({
      code: 'AI_SERVICE_TIMEOUT',
      httpStatus: 504,
      retryable: true,
    });
    expect(call.ms).toBeGreaterThanOrEqual(LEGACY_TIMEOUT_MS - 100);
    expect(call.ms).toBeLessThan(LEGACY_TIMEOUT_MS + TIMEOUT_SLACK_MS);
  }, 30_000);

  it.each([500, 503])(
    'answers upstream %s with a retryable 503 AI_SERVICE_UNAVAILABLE',
    async (status) => {
      answer = { status, body: '{}' };

      expect(rejection((await timed(templates)).result)).toMatchObject({
        code: 'AI_SERVICE_UNAVAILABLE',
        httpStatus: 503,
        retryable: true,
      });
    },
  );

  it.each([400, 404, 429])(
    'answers upstream %s with a non-retryable 502 AI_SERVICE_ERROR',
    async (status) => {
      answer = { status, body: '{}' };

      expect(rejection((await timed(templates)).result)).toMatchObject({
        code: 'AI_SERVICE_ERROR',
        httpStatus: 502,
        retryable: false,
      });
    },
  );

  it.each([
    ['invalid JSON', '<html>oops</html>'],
    ['a payload of the wrong shape', '{"items": []}'],
  ])(
    'answers %s with a non-retryable 502 AI_SERVICE_CONTRACT_VIOLATION',
    async (_label, body) => {
      answer = { status: 200, body };

      expect(rejection((await timed(templates)).result)).toMatchObject({
        code: 'AI_SERVICE_CONTRACT_VIOLATION',
        httpStatus: 502,
        retryable: false,
      });
    },
  );

  it('serves content again once the backend returns', async () => {
    await proxy.setMode('refuse');
    await expect(templates()).rejects.toMatchObject({
      code: 'AI_SERVICE_UNAVAILABLE',
    });

    // The proxy listens again before setMode returns, and the client keeps no
    // connection state, so the next fetch is served.
    await proxy.setMode('normal');
    await expect(templates()).resolves.toMatchObject({
      data: { templates: [], next_cursor: null },
    });
  });
});
