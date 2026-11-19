import { type Static, type TSchema, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { isRecord } from '@/common/is-record';
import { ModelQuote, ModelText } from '@/contracts/model-text';

import {
  BandSchema,
  CriterionIdSchema,
  GradeTask1RequestSchema,
  GradeTask2RequestSchema,
} from '@/contracts/writing/grading';
import { WRITING_V2_ESSAY_MAX_WORDS } from '@/modules/writing/public/grading-policy';

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

const WritingErrorPriorityGroupSchema = Type.Union([
  Type.Literal('task_achievement_response_coherence_cohesion'),
  Type.Literal('lexical_resource'),
  Type.Literal('grammatical_range_accuracy'),
]);

export const WritingErrorPrioritySchema = Type.Object(
  {
    rank: Type.Integer({ minimum: 1, maximum: 3 }),
    group: WritingErrorPriorityGroupSchema,
    code: ModelText(),
    name_en: ModelText(),
    name_vi: ModelText(),
    reason_vi: ModelText(),
  },
  { additionalProperties: false },
);

const ErrorSchema = Type.Object(
  {
    quote: ModelQuote(),
    // A standard code such as `LR03`. A string in both captures; opaque, so a
    // provider rename is not a breaking change (ADR-0143 decision 3).
    error_codes: ModelText(),
    error_name: ModelText(),
    explanation: ModelText(),
    improved_version: ModelQuote(),
  },
  { additionalProperties: false },
);

const SuggestionSchema = Type.Object(
  {
    quote: ModelQuote(),
    explanation: ModelText(),
    improved_version: ModelQuote(),
  },
  { additionalProperties: false },
);

const CriterionSchema = Type.Object(
  {
    id: CriterionIdSchema,
    band: BandSchema,
    band_reason: ModelText(),
    strengths: Type.Array(ModelText()),
    areas_for_improvement: Type.Array(ModelText()),
    errors: Type.Array(ErrorSchema),
    suggestions: Type.Array(SuggestionSchema),
    feedback_detail: Type.Array(ModelText()),
  },
  { additionalProperties: false },
);

const MicroComment = Type.Object(
  { quote: ModelQuote(), explanation: ModelText() },
  { additionalProperties: false },
);

/**
 * Open on purpose: trait key, then error code, then this object. The codes are
 * opaque strings with no `enum` and no `pattern`. A client sends the object
 * back unchanged to the micro-exercise operations (#1454).
 */
const MicroExerciseSchema = Type.Object(
  {
    prompt: ModelText(),
    question_type: ModelText(),
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
            overall: ModelText(),
            detail: Type.Array(ModelText()),
            cta: ModelText(),
          },
          { additionalProperties: false },
        ),
        progress: Type.Object(
          {
            status: ModelText(),
            error_recur: Type.Array(ModelText()),
            error_impro: Type.Array(ModelText()),
            error_new: Type.Array(ModelText()),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    error_priority: Type.Array(WritingErrorPrioritySchema, { maxItems: 3 }),
    // TypeBox turns a record key schema into a pattern and drops its length, so
    // the keys carry no `maxLength` here; the adapter bounds them (#377).
    data_micro: Type.Record(
      Type.String(),
      Type.Record(Type.String(), MicroExerciseSchema),
    ),
  },
  { additionalProperties: false },
);

function withoutMaxLength<T extends TSchema>(schema: T): T {
  const clone = Value.Clone(schema);
  const pending: unknown[] = [clone];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const item of node as unknown[]) pending.push(item);
      continue;
    }
    if (!isRecord(node)) continue;
    delete node['maxLength'];
    for (const value of Object.values(node)) pending.push(value);
  }
  return clone;
}

/** Read-only idempotency shape for completed grades written before `error_priority`. */
const StoredWritingV2GradeResponseSchema = withoutMaxLength(
  WritingV2GradeResponseSchema,
);

export const WritingV2StoredGradeResponseSchema = Type.Object(
  {
    ...StoredWritingV2GradeResponseSchema.properties,
    error_priority: Type.Optional(
      StoredWritingV2GradeResponseSchema.properties.error_priority,
    ),
  },
  { additionalProperties: false },
);

export type WritingV2GradeResponse = Static<
  typeof WritingV2GradeResponseSchema
>;
