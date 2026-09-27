import { type Static, Type } from '@sinclair/typebox';

export const SpeakingPartSchema = Type.Integer({ minimum: 1, maximum: 3 });

export type SpeakingPart = 1 | 2 | 3;

export const SpeakingQuestionsQuerySchema = Type.Object(
  {
    part: Type.Optional(
      Type.Union([Type.Literal('1'), Type.Literal('2'), Type.Literal('3')]),
    ),
  },
  { additionalProperties: false },
);

export const SpeakingQuestionSchema = Type.Object(
  {
    question_id: Type.String({ minLength: 1 }),
    part: SpeakingPartSchema,
    prompt_text: Type.String({ minLength: 1 }),
    audio_url: Type.String({ minLength: 1, maxLength: 2_048 }),
  },
  { additionalProperties: false },
);

/**
 * The unfiltered listing answers with `part: null` rather than omitting the
 * field, so a client can tell an all-parts response from a filtered one.
 */
export const SpeakingQuestionsResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        part: Type.Union([SpeakingPartSchema, Type.Null()]),
        questions: Type.Array(SpeakingQuestionSchema),
      },
      { additionalProperties: false },
    ),
    meta: Type.Object(
      {
        request_id: Type.String({ pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$' }),
        service: Type.Literal('speaking'),
        operation: Type.Literal('speaking.questions'),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type SpeakingQuestionsResponse = Static<
  typeof SpeakingQuestionsResponseSchema
>;
