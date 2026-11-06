import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  type Http2Session,
  type ServerHttp2Stream,
  createSecureServer,
  constants as http2Constants,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { Pool } from 'undici/index.js';

import { getMetrics } from '@/common/observability/metrics';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type { DownstreamRequest } from '@/downstream/downstream.types';
import type { DownstreamRetryBudgetPort } from '@/modules/gateway/application/dispatch/downstream-retry-budget.port';
import { DownstreamCircuitBreakers } from '@/modules/gateway/infrastructure/dispatch/downstream-circuit-breakers';
import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/dispatch/downstream-http.client';
import { createHttpOperationDispatcher } from '@/modules/gateway/infrastructure/dispatch/http-operation-dispatcher.testing';
import { noOpDispatchAttemptRecord } from '@/modules/metering/testing/no-op-dispatch-attempt-record';

type AttemptAction =
  | 'success'
  | 'refused'
  | 'goaway-below'
  | 'goaway-above'
  | 'hold';

const requestBody = { essay: 'one logical grading request' };
const serializedBody = JSON.stringify(requestBody);
const key = createPrivateKey({
  key: readFileSync(
    join(process.cwd(), 'test/fixtures/downstream-http2/server-key.der'),
  ),
  format: 'der',
  type: 'pkcs8',
}).export({ format: 'pem', type: 'pkcs8' });
const cert = Buffer.from(
  readFileSync(
    join(process.cwd(), 'test/fixtures/downstream-http2/server-cert.fixture'),
    'utf8',
  ),
  'base64',
).toString('utf8');

function sendResetFrame(
  socket: TLSSocket,
  streamId: number,
  errorCode: number,
): void {
  const frame = Buffer.alloc(13);
  frame.writeUIntBE(4, 0, 3);
  frame[3] = 0x3;
  frame.writeUInt32BE(streamId, 5);
  frame.writeUInt32BE(errorCode, 9);
  socket.write(frame);
}

function sendGoAwayFrame(socket: TLSSocket, lastStreamId: number): void {
  const frame = Buffer.alloc(17);
  frame.writeUIntBE(8, 0, 3);
  frame[3] = 0x7;
  frame.writeUInt32BE(lastStreamId, 9);
  socket.write(frame);
}

function streamIdOf(stream: ServerHttp2Stream): number {
  if (typeof stream.id !== 'number') {
    throw new Error('HTTP/2 server stream has no assigned ID');
  }
  return stream.id;
}

function createHttp2Harness(actions: readonly AttemptAction[]) {
  const attempts: string[] = [];
  const streamIds: number[] = [];
  const executions: string[] = [];
  const protocols: string[] = [];
  const sessions: Http2Session[] = [];
  const pendingSessions: Http2Session[] = [];
  const pendingSockets: TLSSocket[] = [];
  const sessionSockets = new WeakMap<Http2Session, TLSSocket>();
  const streamWaiters: Array<{ count: number; resolve: () => void }> = [];
  const goawayResponses: Array<{
    stream: ServerHttp2Stream;
    body: string;
  }> = [];
  const server = createSecureServer({ key, cert, allowHTTP1: false });
  const attachSocket = (session: Http2Session, socket: TLSSocket) => {
    sessionSockets.set(session, socket);
    protocols.push(
      typeof socket.alpnProtocol === 'string' ? socket.alpnProtocol : '',
    );
  };
  const socketForStream = (stream: ServerHttp2Stream): TLSSocket => {
    const session = stream.session;
    const socket =
      session === undefined ? undefined : sessionSockets.get(session);
    if (socket === undefined) {
      throw new Error('HTTP/2 stream has no associated TLS socket');
    }
    return socket;
  };
  server.on('secureConnection', (socket: TLSSocket) => {
    const session = pendingSessions.shift();
    if (session === undefined) pendingSockets.push(socket);
    else attachSocket(session, socket);
  });
  server.on('session', (session) => {
    sessions.push(session);
    const socket = pendingSockets.shift();
    if (socket === undefined) pendingSessions.push(session);
    else attachSocket(session, socket);
    session.on('error', () => undefined);
  });
  server.on('stream', (stream, headers) => {
    const attempt = attempts.length + 1;
    const action = actions[attempt - 1] ?? 'success';
    attempts.push(`${headers[':method']} ${headers[':path']}`);
    streamIds.push(streamIdOf(stream));
    for (const waiter of streamWaiters.splice(0)) {
      if (attempt >= waiter.count) waiter.resolve();
      else streamWaiters.push(waiter);
    }

    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', () => undefined);
    stream.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      if (action === 'refused') {
        sendResetFrame(
          socketForStream(stream),
          streamIdOf(stream),
          http2Constants.NGHTTP2_REFUSED_STREAM,
        );
      } else if (action === 'goaway-below') {
        sendGoAwayFrame(socketForStream(stream), 0);
      } else if (action === 'goaway-above') {
        goawayResponses.push({ stream, body });
        if (goawayResponses.length === 2) {
          executions.push(
            ...goawayResponses.map(({ body: request }) => request),
          );
          const lastStreamId = Math.max(
            ...goawayResponses.map(({ stream: accepted }) =>
              streamIdOf(accepted),
            ),
          );
          const session = goawayResponses[0]?.stream.session;
          if (session === undefined) {
            throw new Error('HTTP/2 stream has no associated session');
          }
          session.goaway(http2Constants.NGHTTP2_NO_ERROR, lastStreamId);
          for (const { stream: accepted } of goawayResponses) {
            accepted.respond({
              ':status': 200,
              'content-type': 'application/json',
            });
            accepted.end(JSON.stringify({ ok: true }));
          }
        }
      } else if (action === 'success') {
        executions.push(body);
        stream.respond({ ':status': 200, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ ok: true }));
      } else {
        executions.push(body);
      }
    });
  });

  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  let client: DownstreamHttpClient;
  let pool: Pool;
  let origin: string;
  const ready = (async () => {
    await listening;
    const address = server.address() as AddressInfo;
    origin = `https://127.0.0.1:${address.port}`;
    pool = new Pool(origin, {
      allowH2: true,
      connections: 1,
      connect: { rejectUnauthorized: false },
    });
    client = new DownstreamHttpClient(origin, pool);
  })();

  return {
    attempts,
    streamIds,
    executions,
    protocols,
    ready,
    get client() {
      return client;
    },
    waitForStreams(count: number): Promise<void> {
      if (attempts.length >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        let waiter: { count: number; resolve: () => void };
        const timeout = setTimeout(() => {
          const index = streamWaiters.indexOf(waiter);
          if (index >= 0) streamWaiters.splice(index, 1);
          reject(new Error(`HTTP/2 stream ${count} did not start in time`));
        }, 5_000);
        waiter = {
          count,
          resolve: () => {
            clearTimeout(timeout);
            resolve();
          },
        };
        streamWaiters.push(waiter);
      });
    },
    async close(): Promise<void> {
      await client.close();
      for (const session of sessions) session.destroy();
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  };
}

function jsonRequest(
  client: DownstreamHttpClient,
  signal = AbortSignal.timeout(5_000),
) {
  return client.request(
    {
      method: 'POST',
      path: '/grade',
      body: requestBody,
      contentType: 'application/json',
    },
    {
      downstream: 'ai-writing',
      requestId: 'req_http2_replay',
      deadlineMs: 5_000,
      signal,
    },
  );
}

const adapter: DownstreamAdapter<unknown, unknown> = {
  operation: 'writing.task1.grade',
  downstream: 'ai-writing',
  buildRequest: (): DownstreamRequest => ({
    method: 'POST',
    path: '/grade',
    body: requestBody,
    contentType: 'application/json',
  }),
  parseResponse: (response) => response.body,
};

const retryBudget: DownstreamRetryBudgetPort = {
  isEnabled: () => true,
  expectedAttemptMs: () => 100,
  recordFirstAttempt: async () => true,
  reserveRetry: async () => 'admitted',
};

describe('Undici HTTP/2 protocol replays', () => {
  it('replays one refused JSON stream inside one gateway attempt', async () => {
    const harness = createHttp2Harness(['refused', 'success']);
    await harness.ready;
    const budget: DownstreamRetryBudgetPort = {
      ...retryBudget,
      recordFirstAttempt: async () => true,
      reserveRetry: async () => 'admitted',
    };
    const recordFirstAttempt = jest.spyOn(budget, 'recordFirstAttempt');
    const reserveRetry = jest.spyOn(budget, 'reserveRetry');
    const breakers = new DownstreamCircuitBreakers();
    const breakerExecute = jest.spyOn(breakers, 'execute');
    const dispatcher = createHttpOperationDispatcher(
      harness.client,
      { mint: async () => 'internal-token' },
      [adapter],
      noOpDispatchAttemptRecord,
      undefined,
      budget,
      () => 0,
      breakers,
    );
    const logicalCalls = jest.spyOn(harness.client, 'request');
    try {
      const outcome = await dispatcher
        .dispatch(
          'writing.task1.grade',
          {
            question: 'Describe the chart.',
            chart_type: 'Bar Chart',
            essay: 'A clear essay.',
            image_url: 'https://example.com/chart.png',
          },
          createRequestContext({
            requestId: 'req_http2_replay',
            receivedAt: new Date(),
            deadlineMs: 5_000,
            organizationId: 'org_http2_test',
            scopes: [],
          }),
        )
        .then(
          (value) => value,
          (error: unknown) => ({ error }),
        );
      expect(outcome).toMatchObject({ data: { ok: true } });

      expect(logicalCalls).toHaveBeenCalledTimes(1);
      expect(harness.attempts).toHaveLength(2);
      expect(harness.executions).toEqual([serializedBody]);
      expect(harness.protocols).toEqual(['h2']);
      expect(recordFirstAttempt).toHaveBeenCalledTimes(1);
      expect(reserveRetry).not.toHaveBeenCalled();
      expect(breakerExecute).toHaveBeenCalledTimes(1);
      expect(await getMetrics()).toContain(
        'aihub_breaker_state{operation="writing.task1.grade"} 0',
      );
    } finally {
      breakers.onModuleDestroy();
      await harness.close();
    }
  });

  it('replays a GOAWAY-excluded stream and serves a stream at or below lastStreamID', async () => {
    const excluded = createHttp2Harness(['goaway-below', 'success']);
    await excluded.ready;
    try {
      await expect(jsonRequest(excluded.client)).resolves.toMatchObject({
        status: 200,
        body: { ok: true },
      });
      expect(excluded.attempts).toHaveLength(2);
      expect(excluded.executions).toEqual([serializedBody]);
      expect(excluded.protocols).toEqual(['h2', 'h2']);
    } finally {
      await excluded.close();
    }

    const accepted = createHttp2Harness(['goaway-above', 'goaway-above']);
    await accepted.ready;
    try {
      const responses = await Promise.all([
        jsonRequest(accepted.client),
        jsonRequest(accepted.client),
      ]);
      expect(responses.map(({ status }) => status)).toEqual([200, 200]);
      expect(accepted.streamIds).toEqual([1, 3]);
      expect(accepted.attempts).toHaveLength(2);
      expect(accepted.executions).toEqual([serializedBody, serializedBody]);
    } finally {
      await accepted.close();
    }
  });

  it('bounds repeated and mixed protocol refusals', async () => {
    const repeated = createHttp2Harness(['refused', 'refused', 'success']);
    await repeated.ready;
    try {
      await expect(jsonRequest(repeated.client)).rejects.toMatchObject({
        code: 'AI_SERVICE_UNAVAILABLE',
      });
      expect(repeated.attempts).toHaveLength(2);
      expect(repeated.executions).toEqual([]);
    } finally {
      await repeated.close();
    }

    const goaway = createHttp2Harness([
      'goaway-below',
      'goaway-below',
      'success',
    ]);
    await goaway.ready;
    try {
      await expect(jsonRequest(goaway.client)).rejects.toMatchObject({
        code: 'AI_SERVICE_UNAVAILABLE',
      });
      expect(goaway.attempts).toHaveLength(2);
      expect(goaway.executions).toEqual([]);
    } finally {
      await goaway.close();
    }

    const mixed = createHttp2Harness(['goaway-below', 'refused', 'success']);
    await mixed.ready;
    try {
      await expect(jsonRequest(mixed.client)).resolves.toMatchObject({
        status: 200,
        body: { ok: true },
      });
      expect(mixed.attempts).toHaveLength(3);
      expect(mixed.executions).toEqual([serializedBody]);
    } finally {
      await mixed.close();
    }
  });

  it('does not replay a multipart body and cancels a held replay within its deadline', async () => {
    const multipart = createHttp2Harness(['refused', 'success']);
    await multipart.ready;
    try {
      await expect(
        multipart.client.request(
          {
            method: 'POST',
            path: '/grade',
            body: {
              kind: 'multipart',
              fields: { user_id: 'student' },
              file: {
                fieldName: 'audio',
                filename: 'sample.wav',
                contentType: 'audio/wav',
                blob: new Blob(['audio bytes']),
              },
            },
          },
          {
            downstream: 'ai-speaking',
            requestId: 'req_http2_multipart',
            deadlineMs: 5_000,
            signal: AbortSignal.timeout(5_000),
          },
        ),
      ).rejects.toMatchObject({ code: 'AI_SERVICE_UNAVAILABLE' });
      expect(multipart.attempts).toHaveLength(1);
    } finally {
      await multipart.close();
    }

    const held = createHttp2Harness(['goaway-below', 'hold', 'success']);
    await held.ready;
    const controller = new AbortController();
    const request = jsonRequest(held.client, controller.signal);
    try {
      await held.waitForStreams(2);
      controller.abort();
      await expect(request).rejects.toMatchObject({
        code: 'AI_SERVICE_TIMEOUT',
      });
      expect(held.attempts.length).toBeLessThanOrEqual(2);
      expect(held.executions).toEqual([]);
    } finally {
      controller.abort();
      await held.close();
    }
  });
});
