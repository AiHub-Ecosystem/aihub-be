import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MockAgent } from 'undici/index.js';

import type { AppError } from '@/common/errors/app-error';
import {
  DownstreamHttpClient,
  isDefinitelyNotDispatched,
} from './downstream-http.client';
import { resolvePathParameters } from './http-operation-dispatcher';

describe('DownstreamHttpClient', () => {
  let mockAgent: MockAgent;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
  });

  afterEach(async () => {
    await mockAgent.close();
  });

  it('uses the trusted base URL, bearer token, request metadata, and JSON body', async () => {
    const responseBody = { data: { data: { overall_band: 6 } } };
    const mock = mockAgent.get('https://ai-writing.test');
    mock
      .intercept({
        method: 'POST',
        path: '/grading-feedback-task1',
        body: JSON.stringify({ topic: 'Bar Chart', essay: 'An essay.' }),
        headers: {
          authorization: 'Bearer writing-token',
          'x-request-id': 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
          'x-request-deadline': '9873',
        },
      })
      .reply(200, responseBody);

    const client = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const response = await client.request(
      {
        method: 'POST',
        path: '/grading-feedback-task1',
        body: { topic: 'Bar Chart', essay: 'An essay.' },
        contentType: 'application/json',
      },
      {
        authorization: 'Bearer writing-token',
        requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
        deadlineMs: 9873,
        signal: AbortSignal.timeout(1_000),
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual(responseBody);
  });

  it('forwards trusted identity headers and lets them override configured values', async () => {
    const responseBody = { ok: true };
    mockAgent
      .get('https://ai-speaking.test')
      .intercept({
        method: 'POST',
        path: '/api/v1/speaking/grading-json',
        body: JSON.stringify({ user_id: 'student-1' }),
        headers: {
          'x-aihub-organization-id': 'org_from_context',
          'x-aihub-user-id': 'student-1',
          'x-aihub-user-identity-mode': 'declared_id',
          'x-request-id': 'req_speaking_identity',
          'x-request-deadline': '5000',
        },
      })
      .reply(200, responseBody);

    const client = new DownstreamHttpClient(
      { 'ai-speaking': 'https://ai-speaking.test' },
      mockAgent,
      { 'ai-speaking': { 'x-aihub-organization-id': 'org_stale' } },
    );
    const response = await client.request(
      {
        method: 'POST',
        path: '/api/v1/speaking/grading-json',
        headers: {
          'x-aihub-organization-id': 'org_from_context',
          'x-aihub-user-id': 'student-1',
          'x-aihub-user-identity-mode': 'declared_id',
        },
        body: { user_id: 'student-1' },
      },
      {
        downstream: 'ai-speaking',
        requestId: 'req_speaking_identity',
        deadlineMs: 5000,
        signal: AbortSignal.timeout(1000),
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual(responseBody);
  });

  it('sends a bodyless retrieval to its templated path with trusted identity', async () => {
    const path = resolvePathParameters(
      '/api/v2/speaking/responses/{response_id}',
      { response_id: 'opaque/id' },
    );
    mockAgent
      .get('https://ai-speaking.test')
      .intercept({
        method: 'GET',
        path: '/api/v2/speaking/responses/opaque%2Fid',
        headers: {
          'x-aihub-organization-id': 'org_from_context',
          'x-aihub-user-id': 'student-1',
          'x-aihub-user-identity-mode': 'declared_id',
          'x-request-id': 'req_speaking_retrieval',
          'x-request-deadline': '5000',
        },
      })
      .reply(200, { result: true });

    const client = new DownstreamHttpClient(
      { 'ai-speaking': 'https://ai-speaking.test' },
      mockAgent,
    );
    const response = await client.request(
      {
        method: 'GET',
        path,
        headers: {
          'x-aihub-organization-id': 'org_from_context',
          'x-aihub-user-id': 'student-1',
          'x-aihub-user-identity-mode': 'declared_id',
        },
      },
      {
        downstream: 'ai-speaking',
        requestId: 'req_speaking_retrieval',
        deadlineMs: 5000,
        signal: AbortSignal.timeout(1000),
      },
    );

    expect(path).toBe('/api/v2/speaking/responses/opaque%2Fid');
    expect(response).toMatchObject({ status: 200, body: { result: true } });
  });

  it('rejects an absolute or protocol-relative adapter path', async () => {
    const client = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );

    await expect(
      client.request(
        { method: 'POST', path: '//evil.test/steal', body: {} },
        {
          authorization: 'Bearer writing-token',
          requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
          deadlineMs: 1000,
          signal: AbortSignal.timeout(1000),
        },
      ),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      httpStatus: 500,
    } satisfies Partial<AppError>);
  });

  it('fails fast at one origin without blocking another origin', async () => {
    let speakingRequests = 0;
    let resolveTenSpeakingRequests!: () => void;
    const tenSpeakingRequests = new Promise<void>((resolve) => {
      resolveTenSpeakingRequests = resolve;
    });
    const speakingServer = createServer(() => {
      if (++speakingRequests === 10) resolveTenSpeakingRequests();
    });
    const writingServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const listen = (server: ReturnType<typeof createServer>) =>
      new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await Promise.all([listen(speakingServer), listen(writingServer)]);

    const speakingOrigin = `http://127.0.0.1:${(speakingServer.address() as AddressInfo).port}`;
    const writingOrigin = `http://127.0.0.1:${(writingServer.address() as AddressInfo).port}`;
    const client = new DownstreamHttpClient({
      'ai-speaking': speakingOrigin,
      'ai-writing': writingOrigin,
    });
    const request = (downstream: 'ai-speaking' | 'ai-writing') =>
      client.request(
        { method: 'POST', path: '/grade', body: {} },
        {
          downstream,
          requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
          deadlineMs: 30_000,
          signal: AbortSignal.timeout(30_000),
        },
      );
    const stalled = Array.from({ length: 10 }, () => request('ai-speaking'));
    const settled = Promise.allSettled(stalled);

    try {
      await request('ai-writing');
      await tenSpeakingRequests;
      const rejectedAt = performance.now();
      const bulkheadError = await request('ai-speaking').then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(bulkheadError).toMatchObject({
        code: 'AI_SERVICE_UNAVAILABLE',
        httpStatus: 503,
        retryable: true,
      } satisfies Partial<AppError>);
      expect(isDefinitelyNotDispatched(bulkheadError)).toBe(true);
      expect(performance.now() - rejectedAt).toBeLessThan(20);

      const writingStartedAt = performance.now();
      await expect(request('ai-writing')).resolves.toMatchObject({
        status: 200,
      });
      expect(performance.now() - writingStartedAt).toBeLessThan(20);
    } finally {
      speakingServer.closeAllConnections();
      await settled;
      await client.close();
      await Promise.all(
        [speakingServer, writingServer].map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
      );
    }
  });
  it('routes a degraded provider through the adaptive fast-fail path', async () => {
    let fast = true;
    const serving = createServer((_request, response) => {
      const latency = fast ? 5 : 1_500;
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      }, latency);
    });
    await new Promise<void>((resolve) =>
      serving.listen(0, '127.0.0.1', resolve),
    );
    const origin = `http://127.0.0.1:${(serving.address() as AddressInfo).port}`;
    const client = new DownstreamHttpClient(origin, undefined, {});
    const request = () =>
      client.request(
        { method: 'POST', path: '/grade', body: {} },
        {
          requestId: 'req_adaptive_backoff',
          deadlineMs: 30_000,
          signal: AbortSignal.timeout(30_000),
        },
      );
    try {
      for (let attempt = 0; attempt < 32; attempt += 1) {
        await request();
      }
      fast = false;
      const slow = Array.from({ length: 20 }, () => request());
      const rejectedAt = performance.now();
      const error = await request().then(
        () => undefined,
        (value: unknown) => value,
      );
      expect(error).toMatchObject({
        code: 'AI_SERVICE_UNAVAILABLE',
        retryable: true,
      });
      expect(isDefinitelyNotDispatched(error)).toBe(true);
      expect(performance.now() - rejectedAt).toBeLessThan(50);
      await Promise.allSettled(slow);
    } finally {
      serving.closeAllConnections();
      await client.close();
      await new Promise<void>((resolve, reject) =>
        serving.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
