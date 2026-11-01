import { Value } from '@sinclair/typebox/value';

import {
  SpeakingV2PartGradeRequestSchema,
  SpeakingV2PartPathSchema,
  SpeakingV2QuestionGradeRequestSchema,
  SpeakingV2ResponsePathSchema,
  SpeakingV2TestGradeRequestSchema,
  SpeakingV2TestPathSchema,
} from './requests';

describe('Speaking v2 request schemas', () => {
  it('accepts the public multipart fields without adding the audio file', () => {
    expect(
      Value.Check(SpeakingV2QuestionGradeRequestSchema, {
        part: 1,
        question_id: 'question-1',
        test_type: 'full_test',
        part_result_id: 'part-1',
      }),
    ).toBe(true);
    expect(
      Value.Check(SpeakingV2QuestionGradeRequestSchema, {
        part: 1,
        question_id: 'question-1',
        user_id: 'customer-controlled',
      }),
    ).toBe(false);
  });

  it('requires a part result and at least one test aggregation selector', () => {
    expect(
      Value.Check(SpeakingV2PartGradeRequestSchema, {
        part_result_id: 'part-1',
      }),
    ).toBe(true);
    expect(
      Value.Check(SpeakingV2TestGradeRequestSchema, { test_id: 'test-1' }),
    ).toBe(false);
    expect(
      Value.Check(SpeakingV2TestGradeRequestSchema, {
        test_id: 'test-1',
        response_ids: ['response-1'],
      }),
    ).toBe(true);
  });

  it('validates each retrieval path parameter as a closed object', () => {
    expect(
      Value.Check(SpeakingV2ResponsePathSchema, { response_id: 'r1' }),
    ).toBe(true);
    expect(
      Value.Check(SpeakingV2PartPathSchema, { part_result_id: 'p1' }),
    ).toBe(true);
    expect(Value.Check(SpeakingV2TestPathSchema, { test_id: 't1' })).toBe(true);
    expect(
      Value.Check(SpeakingV2TestPathSchema, { test_id: 't1', user_id: 'u1' }),
    ).toBe(false);
  });
});
