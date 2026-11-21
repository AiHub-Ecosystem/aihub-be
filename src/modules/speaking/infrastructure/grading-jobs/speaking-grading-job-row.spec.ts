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
  it('reads a legacy result without changing it', () => {
    const legacy = parseSpeakingV2QuestionResult(
      fixtureJson('ai-speaking', 'grading-v2-question-post.200.json'),
    );

    expect(mapJob(row(legacy))?.result).toEqual(legacy);
  });

  it('ignores error_priority written by a newer worker', () => {
    const legacy = parseSpeakingV2QuestionResult(
      fixtureJson('ai-speaking', 'grading-v2-question-post.200.json'),
    );
    const future = { ...legacy, error_priority: [{ invalid: true }] };

    expect(mapJob(row(future))?.result).toEqual(legacy);
  });
});
