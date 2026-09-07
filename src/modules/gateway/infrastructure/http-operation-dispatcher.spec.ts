import { MockAgent } from 'undici';

import { createRequestContext } from '../../../common/request-context/request-context.factory';
import type {
  Task1QuestionRequest,
  Task1QuestionResponse,
} from '../../../contracts/writing/task1';
import type {
  Task2QuestionRequest,
  Task2QuestionResponse,
} from '../../../contracts/writing/task2';
import type { DownstreamAdapter } from '../../../downstream/downstream-adapter';
import type {
  DownstreamRequest,
  InternalAIServiceResponse,
} from '../../../downstream/downstream.types';
import type { InternalTokenIssuerPort } from '../application/internal-token-issuer.port';
import { DownstreamHttpClient } from './downstream-http.client';
import { HttpOperationDispatcher } from './http-operation-dispatcher';

function fakeTask1QuestionAdapter(
  path: string,
): DownstreamAdapter<Task1QuestionRequest, Task1QuestionResponse> {
  return {
    operation: 'writing.task1.question.generate',
    downstream: 'ai-writing',
    buildRequest: (input): DownstreamRequest => ({
      method: 'POST',
      path,
      body: input,
    }),
    parseResponse: (
      raw: InternalAIServiceResponse<unknown>,
    ): Task1QuestionResponse => ({
      question_id: 'q_1',
      question: `${(raw.body as { echo: string }).echo}-parsed`,
      chart_type: 'Bar Chart',
      image_url: 'https://example.com/chart.png',
    }),
  };
}

function fakeTask2QuestionAdapter(
  path: string,
): DownstreamAdapter<Task2QuestionRequest, Task2QuestionResponse> {
  return {
    operation: 'writing.task2.question.generate',
    downstream: 'ai-writing',
    buildRequest: (input): DownstreamRequest => ({
      method: 'POST',
      path,
      body: input,
    }),
    parseResponse: (
      raw: InternalAIServiceResponse<unknown>,
    ): Task2QuestionResponse => ({
      question: `${(raw.body as { echo: string }).echo}-parsed`,
      topic: '',
      question_type: 'opinion',
    }),
  };
}

class FakeTokenIssuer implements InternalTokenIssuerPort {
  mint(): Promise<string> {
    return Promise.resolve('token-abc');
  }
}

function context() {
  return createRequestContext({
    requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
    receivedAt: new Date(),
    deadlineMs: 5_000,
    scopes: [],
  });
}

describe('HttpOperationDispatcher', () => {
  let mockAgent: MockAgent;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
  });

  afterEach(async () => {
    await mockAgent.close();
  });

  it('routes to the adapter registered for the requested operation, not any other one', async () => {
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-two' })
      .reply(200, { echo: 'ok' });
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const dispatcher = new HttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [
        fakeTask1QuestionAdapter('/task-one'),
        fakeTask2QuestionAdapter('/task-two'),
      ],
    );

    const result = await dispatcher.dispatch(
      'writing.task2.question.generate',
      { topic: 'education', question_type: 'opinion' },
      context(),
    );

    expect(result).toMatchObject({
      operation: 'writing.task2.question.generate',
      data: { question: 'ok-parsed' },
    });
  });

  it('rejects an operation with no registered adapter instead of silently no-oping', async () => {
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const dispatcher = new HttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeTask1QuestionAdapter('/task-one')],
    );

    // No interceptor registered at all: if the dispatcher tried to reach the
    // network for the unconfigured operation, `disableNetConnect` would
    // surface that as a network error rather than this config error.
    await expect(
      dispatcher.dispatch(
        'writing.task2.question.generate',
        { topic: 'education', question_type: 'opinion' },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', httpStatus: 500 });
  });

  it('maps a downstream 5xx to a retryable unified error', async () => {
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-one' })
      .reply(503, {});
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const dispatcher = new HttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeTask1QuestionAdapter('/task-one')],
    );

    await expect(
      dispatcher.dispatch('writing.task1.question.generate', {}, context()),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_ERROR', retryable: true });
  });

  it('maps a downstream 429 to the throttled error, not the client rate-limit error', async () => {
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-one' })
      .reply(429, {});
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const dispatcher = new HttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeTask1QuestionAdapter('/task-one')],
    );

    await expect(
      dispatcher.dispatch('writing.task1.question.generate', {}, context()),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_THROTTLED', httpStatus: 503 });
  });
});
