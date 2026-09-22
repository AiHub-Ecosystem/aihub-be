import { type Static, Type } from '@sinclair/typebox';

const SpeakingPartSchema = Type.Integer({ minimum: 1, maximum: 3 });

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

export type SpeakingQuestionContract = Static<typeof SpeakingQuestionSchema>;
