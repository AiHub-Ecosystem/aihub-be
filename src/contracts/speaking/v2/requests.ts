import { Type } from '@sinclair/typebox';

import { SPEAKING_AUDIO_MAX_BYTES } from '@/modules/speaking/domain/speaking-audio-asset';
import { SpeakingV2TestTypeSchema } from './response.shared';

export const SpeakingV2QuestionGradeRequestSchema = Type.Object(
  {
    part: Type.Integer({ minimum: 1, maximum: 3 }),
    question_id: Type.String({ minLength: 1 }),
    prompt_text: Type.Optional(Type.String()),
    test_type: Type.Optional(SpeakingV2TestTypeSchema),
    test_code: Type.Optional(Type.String()),
    part_result_id: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { additionalProperties: false },
);

/**
 * The multipart body as the OpenAPI document shows it: the declared fields plus
 * the audio file. The controller reads the file from the stream, so
 * `SpeakingV2QuestionGradeRequestSchema` above validates only the fields.
 */
export const SpeakingV2QuestionGradeMultipartSchema = Type.Object(
  {
    audio: Type.String({
      format: 'binary',
      'x-max-bytes': SPEAKING_AUDIO_MAX_BYTES,
    }),
    ...SpeakingV2QuestionGradeRequestSchema.properties,
  },
  { additionalProperties: false },
);

export const SpeakingV2PartGradeRequestSchema = Type.Object(
  {
    part_result_id: Type.String({ minLength: 1 }),
    part: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
    test_id: Type.Optional(Type.String({ minLength: 1 })),
    test_type: Type.Optional(SpeakingV2TestTypeSchema),
    expected_question_count: Type.Optional(Type.Integer({ minimum: 1 })),
    response_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);

export const SpeakingV2TestGradeRequestSchema = Type.Union([
  Type.Object(
    {
      test_id: Type.String({ minLength: 1 }),
      test_type: Type.Optional(SpeakingV2TestTypeSchema),
      part_result_ids: Type.Array(Type.String({ minLength: 1 })),
      response_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      test_id: Type.String({ minLength: 1 }),
      test_type: Type.Optional(SpeakingV2TestTypeSchema),
      part_result_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      response_ids: Type.Array(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
]);

export const SpeakingV2ResponsePathSchema = Type.Object(
  { response_id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const SpeakingV2PartPathSchema = Type.Object(
  { part_result_id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const SpeakingV2TestPathSchema = Type.Object(
  { test_id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
