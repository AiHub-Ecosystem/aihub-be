import { type ServerResponse, createServer } from 'node:http';
import { type ServerHttp2Stream, createSecureServer } from 'node:http2';
import type { AddressInfo, Server, Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { gzipSync } from 'node:zlib';
import { Pool } from 'undici/index.js';

import { AppError } from '@/common/errors/app-error';
import { DownstreamHttpClient } from './downstream-http.client';
import { tlsStubCredentials } from './downstream-tls-stub.testing';

const LIMIT = 64 * 1024;
const CHUNK = 'a'.repeat(1024);
const JSON_TYPE = { 'content-type': 'application/json' };

type Protocol = 'HTTP/1.1' | 'HTTP/2';

/** What a stub does with a response, whichever protocol carries it. */
interface Sink {
  start(status: number, headers: Record<string, string>): void;
  write(chunk: string | Buffer): boolean;
  end(chunk?: string | Buffer): void;
  onDrain(callback: () => void): void;
  onClose(callback: () => void): void;
  readonly closed: () => boolean;
}

/** A body of exactly `bytes` ASCII bytes that is one valid JSON document. */
function jsonOfSize(bytes: number): string {
  return `{"t":"${'a'.repeat(bytes - 8)}"}`;
}

function serve(route: string, sink: Sink): void {
  const endless = (status: number): void => {
    sink.start(status, JSON_TYPE);
    sink.write('{"text":"');
    const pump = (): void => {
      while (!sink.closed()) {
        if (!sink.write(CHUNK)) {
          sink.onDrain(pump);
          return;
        }
      }
    };
    pump();
  };
  switch (route) {
    case '/ok':
      sink.start(200, JSON_TYPE);
      sink.end('{"ok":true}');
      return;
    case '/exact':
      sink.start(200, JSON_TYPE);
      sink.end(jsonOfSize(LIMIT));
      return;
    case '/declared-over':
      sink.start(200, { ...JSON_TYPE, 'content-length': String(LIMIT + 1) });
      sink.end(jsonOfSize(LIMIT + 1));
      return;
    case '/gzip':
      sink.start(200, { ...JSON_TYPE, 'content-encoding': 'gzip' });
      sink.end(gzipSync('{"ok":true}'));
      return;
    case '/endless':
      endless(200);
      return;
    case '/endless-error':
      endless(503);
      return;
    default:
      sink.start(404, JSON_TYPE);
      sink.end('{}');
  }
}

function http2Sink(stream: ServerHttp2Stream): Sink {
  let closed = false;
  stream.on('error', () => undefined);
  stream.on('close', () => {
    closed = true;
  });
  return {
    start: (status, headers) =>
      stream.respond({ ':status': status, ...headers }),
    write: (chunk) => stream.write(chunk),
    end: (chunk) => void stream.end(chunk),
    onDrain: (callback) => void stream.once('drain', callback),
    onClose: (callback) => void stream.on('close', callback),
    closed: () => closed,
  };
}

function http1Sink(response: ServerResponse): Sink {
  let closed = false;
  response.on('error', () => undefined);
  response.on('close', () => {
    closed = true;
  });
  return {
    start: (status, headers) => void response.writeHead(status, headers),
    write: (chunk) => response.write(chunk),
    end: (chunk) => void response.end(chunk),
    onDrain: (callback) => void response.once('drain', callback),
    onClose: (callback) => void response.on('close', callback),
    closed: () => closed,
  };
}

async function startStub(protocol: Protocol) {
  const cancellations = new Map<string, Promise<void>>();
  const alpn: string[] = [];
  const sockets = new Set<Socket>();
  const serveRoute = (route: string, sink: Sink): void => {
    // Resolves when the client side of this response goes away.
    cancellations.set(
      route,
      new Promise<void>((resolve) => sink.onClose(resolve)),
    );
    serve(route, sink);
  };

  let server: Server;
  if (protocol === 'HTTP/2') {
    const secure = createSecureServer({
      ...tlsStubCredentials,
      allowHTTP1: false,
    });
    secure.on('secureConnection', (socket: TLSSocket) => {
      alpn.push(String(socket.alpnProtocol));
    });
    secure.on('stream', (stream, headers) => {
      serveRoute(String(headers[':path']), http2Sink(stream));
    });
    server = secure;
  } else {
    server = createServer((request, response) => {
      serveRoute(String(request.url), http1Sink(response));
    });
  }
  server.on('connection', (socket: Socket) => sockets.add(socket));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const origin = `${protocol === 'HTTP/2' ? 'https' : 'http'}://127.0.0.1:${port}`;
  // One connection: a body that is rejected but not cancelled keeps it busy,
  // and the next request then waits for the rejected response's deadline.
  const pool = new Pool(origin, {
    allowH2: protocol === 'HTTP/2',
    connections: 1,
    connect: { rejectUnauthorized: false },
  });
  const client = new DownstreamHttpClient(origin, pool);

  return {
    client,
    alpn,
    /** Settles once the server has seen the client drop that response. */
    cancelled: (route: string): Promise<void> =>
      cancellations.get(route) ?? Promise.reject(new Error('route not served')),
    async close(): Promise<void> {
      await client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function get(client: DownstreamHttpClient, path: string) {
  return client.request(
    { method: 'GET', path },
    {
      requestId: 'req_response_limit',
      deadlineMs: 5_000,
      signal: AbortSignal.timeout(5_000),
      maxResponseBytes: LIMIT,
    },
  );
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the request to be rejected');
}

describe.each(['HTTP/1.1', 'HTTP/2'] as const)(
  'DownstreamHttpClient response byte limit over %s',
  (protocol) => {
    let stub: Awaited<ReturnType<typeof startStub>>;

    beforeEach(async () => {
      stub = await startStub(protocol);
    });

    afterEach(async () => {
      await stub.close();
    });

    it('runs over the protocol under test', async () => {
      await get(stub.client, '/ok');

      expect(stub.alpn).toEqual(protocol === 'HTTP/2' ? ['h2'] : []);
    });

    it.each([
      ['an oversized success body', '/endless'],
      ['an oversized non-success body', '/endless-error'],
    ])(
      'rejects %s that has no Content-Length, cancels it, and serves the next request',
      async (_name, path) => {
        const error = await rejection(get(stub.client, path));

        expect(error).toMatchObject({
          code: 'AI_SERVICE_CONTRACT_VIOLATION',
          retryable: false,
        });
        expect(error.diagnostic).toBe(
          `response body exceeds the ${LIMIT} byte limit`,
        );
        await stub.cancelled(path);
        await expect(get(stub.client, '/ok')).resolves.toMatchObject({
          status: 200,
          body: { ok: true },
        });
      },
    );

    it('rejects a body whose declared length is over the limit', async () => {
      const error = await rejection(get(stub.client, '/declared-over'));

      expect(error.code).toBe('AI_SERVICE_CONTRACT_VIOLATION');
      await expect(get(stub.client, '/ok')).resolves.toMatchObject({
        status: 200,
      });
    });

    it('accepts a body of exactly the limit', async () => {
      const response = await get(stub.client, '/exact');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(JSON.parse(jsonOfSize(LIMIT)));
    });

    it('does not decode a content-encoded body, so the limit counts the bytes received', async () => {
      const error = await rejection(get(stub.client, '/gzip'));

      expect(error.code).toBe('AI_SERVICE_CONTRACT_VIOLATION');
    });
  },
);
