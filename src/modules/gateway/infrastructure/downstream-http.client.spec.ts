import { MockAgent } from 'undici';

import type { AppError } from '../../../common/errors/app-error';
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
    const responseBody = { data: { data: { question: 'A question' } } };
    const mock = mockAgent.get('https://ai-writing.test');
    mock
      .intercept({
        method: 'POST',
        path: '/generate-question-task1',
        body: JSON.stringify({ topic: 'Bar Chart' }),
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
        path: '/generate-question-task1',
        body: { topic: 'Bar Chart' },
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
});
