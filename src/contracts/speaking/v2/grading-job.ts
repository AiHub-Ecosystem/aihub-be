import { type Static, Type } from '@sinclair/typebox';
import '@/contracts/date-time-format';

import { ResponseMetaSchema } from '@/contracts/response-meta';
import { SpeakingV2QuestionResultSchema } from './question-result';
import { SpeakingV2QuestionGradeRequestSchema } from './requests';

const SpeakingGradingJobIdSchema = Type.String({
  pattern: '^sgj_[0-9A-HJKMNP-TV-Z]{26}$',
});

const SpeakingGradingJobStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
]);

const SpeakingGradingJobErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const SpeakingGradingJobSubmitRequestSchema = Type.Object(
  {
    audio_asset_id: Type.String({
      pattern: '^aud_[0-9A-HJKMNP-TV-Z]{26}$',
    }),
    ...SpeakingV2QuestionGradeRequestSchema.properties,
  },
  { additionalProperties: false },
);

export type SpeakingGradingJobSubmitRequest = Static<
  typeof SpeakingGradingJobSubmitRequestSchema
>;

export const SpeakingGradingJobAcceptedDataSchema = Type.Object(
  {
    job_id: SpeakingGradingJobIdSchema,
    status: Type.Literal('queued'),
  },
  { additionalProperties: false },
);

export type SpeakingGradingJobAcceptedData = Static<
  typeof SpeakingGradingJobAcceptedDataSchema
>;

export const SpeakingGradingJobSubmitResponseSchema = Type.Object(
  {
    data: SpeakingGradingJobAcceptedDataSchema,
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);

export type SpeakingGradingJobSubmitResponse = Static<
  typeof SpeakingGradingJobSubmitResponseSchema
>;

export const SpeakingGradingJobPollDataSchema = Type.Object(
  {
    job_id: SpeakingGradingJobIdSchema,
    status: SpeakingGradingJobStatusSchema,
    created_at: Type.String({ format: 'date-time' }),
    completed_at: Type.Optional(Type.String({ format: 'date-time' })),
    result: Type.Optional(SpeakingV2QuestionResultSchema),
    error: Type.Optional(SpeakingGradingJobErrorSchema),
  },
  { additionalProperties: false },
);

export type SpeakingGradingJobPollData = Static<
  typeof SpeakingGradingJobPollDataSchema
>;

export const SpeakingGradingJobPollResponseSchema = Type.Object(
  {
    data: SpeakingGradingJobPollDataSchema,
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);

export type SpeakingGradingJobPollResponse = Static<
  typeof SpeakingGradingJobPollResponseSchema
>;
