import { isRecord } from '@/common/is-record';
import { parseSpeakingV2QuestionResult } from '@/downstream/speaking/speaking-v2-question-response.adapter';
import { fixtureJson } from '../../../../../test/support/json-fixtures';
import { type SpeakingGradingJobRow, mapJob } from './speaking-grading-job-row';

function row(result: unknown): SpeakingGradingJobRow {
  return {
    jobId: 'sgj_01J00000000000000000000001',
    organizationId: 'org_test',
    endUserId: 'user_test',
    environment: 'production',
    identityMode: 'declared_id',
    apiKeyId: 'ak_test',
    maxConcurrent: 4,
    quotaTracked: true,
    quotaUnverified: false,
    audioAssetId: 'aud_01J00000000000000000000001',
    part: 1,
    questionId: 'p1_hometown',
    promptText: null,
    testType: null,
    testCode: null,
    partResultId: null,
    idempotencyKey: null,
    status: 'succeeded',
    leaseExpiresAt: null,
    dispatchStartedAt: null,
    result,
    errorCode: null,
    errorMessage: null,
    errorRetryable: null,
    createdAt: new Date('2026-11-08T12:00:00.000Z'),
    completedAt: null,
  };
}

describe('stored Speaking grading job results', () => {
  it('reads a pre-error_priority result with an empty list', () => {
    const current = resultWithPriorities([]);
    const legacy: Record<string, unknown> = { ...current };
    delete legacy['error_priority'];

    expect(mapJob(row(legacy))?.result?.error_priority).toEqual([]);
  });

  it('keeps priorities in a current stored result', () => {
    const priorities = prioritySample('question_result');
    const result = resultWithPriorities(priorities);

    expect(mapJob(row(result))?.result?.error_priority).toHaveLength(1);
  });
});

function prioritySample(resultType: string): unknown[] {
  const sample = fixtureJson(
    'ai-speaking',
    'grading-v2-error-priority.provider-sample.json',
  );
  if (!isRecord(sample) || !Array.isArray(sample[resultType])) {
    throw new Error(`provider priority sample has no ${resultType}`);
  }
  return sample[resultType];
}

function resultWithPriorities(value: unknown) {
  const body = fixtureJson('ai-speaking', 'grading-v2-question-post.200.json');
  if (!isRecord(body) || !isRecord(body['data'])) {
    throw new Error('provider fixture has no data object');
  }
  body['data']['error_priority'] = value;
  return parseSpeakingV2QuestionResult(body);
}
