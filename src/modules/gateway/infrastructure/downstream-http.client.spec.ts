import { type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MockAgent } from 'undici/index.js';

import type { AppError } from '@/common/errors/app-error';
import { getMetrics } from '@/common/observability/metrics';
import { DownstreamHttpClient } from './downstream-http.client';

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

  it('reports requests waiting beyond the configured downstream pool connections', async () => {
    let requestsSeen = 0;
    let resolveTenRequests!: () => void;
    let responsesReleased = false;
    const pendingResponses: ServerResponse[] = [];
    const tenRequestsArrived = new Promise<void>((resolve) => {
      resolveTenRequests = resolve;
    });
    const sendResponse = (response: ServerResponse): void => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    };
    const server = createServer((_request, response) => {
      requestsSeen += 1;
      if (requestsSeen === 10) resolveTenRequests();
      if (responsesReleased) sendResponse(response);
      else pendingResponses.push(response);
    });
    const releaseResponses = (): void => {
      responsesReleased = true;
      pendingResponses.splice(0).forEach(sendResponse);
    };
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new DownstreamHttpClient(origin);
    const requests = Array.from({ length: 11 }, () =>
      client.request(
        { method: 'POST', path: '/queued', body: {} },
        {
          requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
          deadlineMs: 5000,
          signal: AbortSignal.timeout(5000),
        },
      ),
    );

    try {
      await tenRequestsArrived;
      expect(await getMetrics()).toContain(
        `aihub_downstream_pool_queued{origin="${origin}"} 1`,
      );
      releaseResponses();
      await Promise.allSettled(requests);
      expect(await getMetrics()).toContain(
        `aihub_downstream_pool_queued{origin="${origin}"} 0`,
      );
    } finally {
      releaseResponses();
      await Promise.allSettled(requests);
      await client.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(await getMetrics()).not.toContain(`origin="${origin}"`);
  });
});
