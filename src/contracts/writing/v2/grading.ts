import { type Static, Type } from '@sinclair/typebox';

import {
  BandSchema,
  CriterionIdSchema,
  GradeTask1RequestSchema,
  GradeTask2RequestSchema,
} from '@/contracts/writing/grading';

/**
 * The longest essay AI Writing v3 grades. The provider answers 413 for a longer
 * one only after the caller has waited, so AIHUB refuses it first (ADR-0143
 * decision 11). Words are runs of non-whitespace characters.
 */
export const WRITING_V2_ESSAY_MAX_WORDS = 1_000;

const ESSAY_WORD_NOTE = `An essay of more than ${WRITING_V2_ESSAY_MAX_WORDS} words, counted by whitespace, is refused with INVALID_REQUEST.`;

/** `/v2` takes the `/v1` request body; only the essay limit is stated more. */
export const WritingV2GradeTask1RequestSchema = Type.Object(
  {
    ...GradeTask1RequestSchema.properties,
    essay: Type.String({
      minLength: 1,
      maxLength: 20_000,
      description: `The limit counts UTF-16 code units. ${ESSAY_WORD_NOTE}`,
    }),
  },
  { additionalProperties: false },
);

export const WritingV2GradeTask2RequestSchema = Type.Object(
  {
    ...GradeTask2RequestSchema.properties,
    essay: Type.String({
      minLength: 1,
      maxLength: 20_000,
      description: `The limit counts UTF-16 code units. ${ESSAY_WORD_NOTE}`,
    }),
  },
  { additionalProperties: false },
);

export type WritingV2GradeTask1Request = Static<
  typeof WritingV2GradeTask1RequestSchema
>;
export type WritingV2GradeTask2Request = Static<
  typeof WritingV2GradeTask2RequestSchema
>;

const ErrorSchema = Type.Object(
  {
    quote: Type.String(),
    // A standard code such as `LR03`. A string in both captures; opaque, so a
    // provider rename is not a breaking change (ADR-0143 decision 3).
    error_codes: Type.String(),
    error_name: Type.String(),
    explanation: Type.String(),
    improved_version: Type.String(),
  },
  { additionalProperties: false },
);

const SuggestionSchema = Type.Object(
  {
    quote: Type.String(),
    explanation: Type.String(),
    improved_version: Type.String(),
  },
  { additionalProperties: false },
);

const CriterionSchema = Type.Object(
  {
    id: CriterionIdSchema,
    band: BandSchema,
    band_reason: Type.String(),
    strengths: Type.Array(Type.String()),
    areas_for_improvement: Type.Array(Type.String()),
    errors: Type.Array(ErrorSchema),
    suggestions: Type.Array(SuggestionSchema),
    feedback_detail: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const MicroComment = Type.Object(
  { quote: Type.String(), explanation: Type.String() },
  { additionalProperties: false },
);

/**
 * Open on purpose: trait key, then error code, then this object. The codes are
 * opaque strings with no `enum` and no `pattern`. A client sends the object
 * back unchanged to the micro-exercise operations (#1454).
 */
const MicroExerciseSchema = Type.Object(
  {
    prompt: Type.String(),
    question_type: Type.String(),
    comments: Type.Array(MicroComment),
  },
  { additionalProperties: false },
);

export const WritingV2GradeResponseSchema = Type.Object(
  {
    overall_band: BandSchema,
    criteria: Type.Array(CriterionSchema, { minItems: 4, maxItems: 4 }),
    overall_assessment: Type.Object(
      {
        summary: Type.Object(
          {
            overall: Type.String(),
            detail: Type.Array(Type.String()),
            cta: Type.String(),
          },
          { additionalProperties: false },
        ),
        progress: Type.Object(
          {
            status: Type.String(),
            error_recur: Type.Array(Type.String()),
            error_impro: Type.Array(Type.String()),
            error_new: Type.Array(Type.String()),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    data_micro: Type.Record(
      Type.String(),
      Type.Record(Type.String(), MicroExerciseSchema),
    ),
  },
  { additionalProperties: false },
);

export type WritingV2GradeResponse = Static<
  typeof WritingV2GradeResponseSchema
>;
