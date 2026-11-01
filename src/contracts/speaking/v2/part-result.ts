import { type Static, Type } from '@sinclair/typebox';

import {
  SpeakingV2CriteriaSchema,
  SpeakingV2FeedbackSchema,
  SpeakingV2ScoresSchema,
  SpeakingV2TestTypeSchema,
} from './response.shared';

export const SpeakingV2PartResultSchema = Type.Object(
  {
    meta: Type.Object(
      {
        schema_version: Type.Literal('2.4'),
        result_type: Type.Literal('part_result'),
        test_id: Type.Union([Type.String(), Type.Null()]),
        test_type: SpeakingV2TestTypeSchema,
        part_result_id: Type.String({ minLength: 1 }),
        part: Type.Integer({ minimum: 1, maximum: 3 }),
        question_count: Type.Integer({ minimum: 0 }),
        total_speaking_seconds: Type.Union([
          Type.Number({ minimum: 0 }),
          Type.Null(),
        ]),
        graded_at: Type.String(),
      },
      { additionalProperties: false },
    ),
    scores: SpeakingV2ScoresSchema,
    overall_feedback: SpeakingV2FeedbackSchema,
    criteria: SpeakingV2CriteriaSchema,
  },
  { additionalProperties: false },
);

export type SpeakingV2PartResult = Static<typeof SpeakingV2PartResultSchema>;
