import { Blob } from 'node:buffer';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import {
  speakingV2PartGradingAdapter,
  speakingV2QuestionGradingAdapter,
  speakingV2TestGradingAdapter,
} from './speaking-v2.adapters';

const context = createRequestContext({
  requestId: 'req_01M2MNRPCGCT96P54KDBE82MH7',
  receivedAt: new Date(),
  deadlineMs: 5_000,
  organizationId: 'org_acme',
  userId: 'student-1',
  identityMode: 'declared_id',
  scopes: [],
});

const audio = {
  blob: new Blob(['synthetic audio']),
  filename: 'answer.wav',
  contentType: 'audio/wav',
};

const SPELLINGS = [
  ['practice', 'Practice'],
  ['full_test', 'Full-test'],
] as const;

// The provider spells test_type `Practice` / `Full-test` on every request
// (contract v2.4 section 3); the public `/v2` value is `practice` / `full_test`.
describe('Speaking /v2 request test_type spelling', () => {
  it.each(SPELLINGS)(
    'question grade sends %s as %s',
    (publicValue, providerValue) => {
      const request = speakingV2QuestionGradingAdapter.buildRequest(
        { audio, part: 1, questionId: 'q1', testType: publicValue },
        context,
      );

      expect(request.body).toMatchObject({
        kind: 'multipart',
        fields: { test_type: providerValue },
      });
    },
  );

  it.each(SPELLINGS)(
    'Part aggregation sends %s as %s',
    (publicValue, providerValue) => {
      const request = speakingV2PartGradingAdapter.buildRequest(
        { part_result_id: 'part-1', test_type: publicValue },
        context,
      );

      expect(request.body).toEqual({
        part_result_id: 'part-1',
        test_type: providerValue,
      });
    },
  );

  it.each(SPELLINGS)(
    'Test aggregation sends %s as %s',
    (publicValue, providerValue) => {
      const request = speakingV2TestGradingAdapter.buildRequest(
        {
          test_id: 'test-1',
          test_type: publicValue,
          part_result_ids: ['part-1'],
        },
        context,
      );

      expect(request.body).toEqual({
        test_id: 'test-1',
        test_type: providerValue,
        part_result_ids: ['part-1'],
      });
    },
  );

  it('omits test_type from an aggregation that did not declare one', () => {
    const request = speakingV2PartGradingAdapter.buildRequest(
      { part_result_id: 'part-1' },
      context,
    );

    expect(request.body).toEqual({ part_result_id: 'part-1' });
  });
});
