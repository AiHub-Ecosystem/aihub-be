import { MockAgent } from 'undici';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import type {
  GradeResponse,
  GradeTask1Request,
} from '@/contracts/writing/grading';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type { DownstreamRequest } from '@/downstream/downstream.types';
import type { InternalTokenIssuerPort } from '@/modules/gateway/application/internal-token-issuer.port';
import { noOpDispatchAttemptRecord } from '@/modules/metering/testing/no-op-dispatch-attempt-record';
import { DownstreamHttpClient } from './downstream-http.client';
import { HttpOperationDispatcher } from './http-operation-dispatcher';

const gradeInput: GradeTask1Request = {
  question: 'Describe the chart.',
  chart_type: 'Bar Chart',
  essay: 'A clear essay.',
  image_url: 'https://example.com/chart.png',
};

const gradeResponse: GradeResponse = {
  overall_band: 7,
  language: 'vi',
  criteria: [
    {
      id: 'task_achievement',
      name: 'Task Achievement',
      band: 7,
      band_reason: 'clear',
      strengths: [],
      improvements: [],
    },
    {
      id: 'coherence_cohesion',
      name: 'Coherence and Cohesion',
      band: 7,
      band_reason: 'clear',
      strengths: [],
      improvements: [],
    },
    {
      id: 'lexical_resource',
      name: 'Lexical Resource',
      band: 7,
      band_reason: 'clear',
      strengths: [],
      improvements: [],
    },
    {
      id: 'grammatical_range_accuracy',
      name: 'Grammatical Range and Accuracy',
      band: 7,
      band_reason: 'clear',
      strengths: [],
      improvements: [],
    },
  ],
  summary: 'clear',
  suggestions: [],
  next_steps: [],
  annotations: [],
};

const adapter: DownstreamAdapter<GradeTask1Request, GradeResponse> = {
  operation: 'writing.task1.grade',
  downstream: 'ai-writing',
  buildRequest: (input): DownstreamRequest => ({
    method: 'POST',
    path: '/grade',
    body: input,
  }),
  parseResponse: () => gradeResponse,
};

const issuer: InternalTokenIssuerPort = {
  mint: async () => 'internal-token',
};

describe('HttpOperationDispatcher telemetry', () => {
  let agent: MockAgent;

  afterEach(async () => {
    await agent.close();
  });

  it('keeps provider usage internal while returning sanitized dispatch telemetry', async () => {
    agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/grade' })
      .reply(200, {
        data: { accepted: true },
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        models: [{ provider: 'provider-y', name: 'model-x' }],
        metrics: { ai_processing_ms: 70 },
      });

    const dispatcher = new HttpOperationDispatcher(
      new DownstreamHttpClient('https://ai-writing.test', agent),
      issuer,
      [adapter],
      noOpDispatchAttemptRecord,
    );
    const result = await dispatcher.dispatch(
      'writing.task1.grade',
      gradeInput,
      createRequestContext({
        requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
        receivedAt: new Date(),
        deadlineMs: 5_000,
        organizationId: 'org_test',
        scopes: [],
      }),
    );

    expect(result.data).toEqual(gradeResponse);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    expect(result.models).toEqual([
      { provider: 'provider-y', name: 'model-x' },
    ]);
    expect(result.aiProcessingMs).toBe(70);
  });
});
