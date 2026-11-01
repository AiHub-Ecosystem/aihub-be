import { type Static, Type } from '@sinclair/typebox';

import {
  SpeakingV2CriteriaSchema,
  SpeakingV2FeedbackSchema,
  SpeakingV2ScoresSchema,
  SpeakingV2TestTypeSchema,
  SpeakingV2TranscriptSchema,
} from './response.shared';

export const SpeakingV2QuestionResultSchema = Type.Object(
  {
    meta: Type.Object(
      {
        schema_version: Type.Literal('2.4'),
        result_type: Type.Literal('question_result'),
        test_id: Type.String(),
        test_type: SpeakingV2TestTypeSchema,
        part: Type.Integer({ minimum: 1, maximum: 3 }),
        question_id: Type.String({ minLength: 1 }),
        response_id: Type.String({ minLength: 1 }),
        part_result_id: Type.String({ minLength: 1 }),
        graded_at: Type.String(),
      },
      { additionalProperties: false },
    ),
    transcript: SpeakingV2TranscriptSchema,
    scores: SpeakingV2ScoresSchema,
    overall_feedback: SpeakingV2FeedbackSchema,
    criteria: SpeakingV2CriteriaSchema,
  },
  { additionalProperties: false },
);

export type SpeakingV2QuestionResult = Static<
  typeof SpeakingV2QuestionResultSchema
>;
