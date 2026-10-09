import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { ChartTypeSchema } from './task1';

/**
 * Downstream only produces Vietnamese feedback today. Widening this later is a
 * non-breaking change; narrowing would not be, so it starts closed.
 */
export const LANGUAGES = ['vi'] as const;

const LanguageSchema = Type.Union(
  LANGUAGES.map((value) => Type.Literal(value)),
);

/**
 * IELTS awards whole and half bands only. `multipleOf` accepts both the integer
 * criterion scores and the float overall band the downstream returns, so the
 * schema must not force a float type.
 */
const BandSchema = Type.Number({ minimum: 0, maximum: 9, multipleOf: 0.5 });

/** Task 1 grades Task Achievement; Task 2 grades Task Response. */
export const CRITERION_IDS = [
  'task_achievement',
  'task_response',
  'coherence_cohesion',
  'lexical_resource',
  'grammatical_range_accuracy',
] as const;

export type CriterionId = (typeof CRITERION_IDS)[number];

const CriterionIdSchema = Type.Union(
  CRITERION_IDS.map((value) => Type.Literal(value)),
);

export const GradeTask1RequestSchema = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 2_000 }),
    chart_type: ChartTypeSchema,
    essay: Type.String({ minLength: 1, maxLength: 20_000 }),
    image_url: Type.String({
      format: 'uri',
      pattern: '^[hH][tT][tT][pP][sS]://',
      maxLength: 2_000,
    }),
    language: Type.Optional(LanguageSchema),
  },
  { additionalProperties: false },
);

export type GradeTask1Request = Static<typeof GradeTask1RequestSchema>;

export const GradeTask2RequestSchema = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 2_000 }),
    // Unlike Task 1, this really is a subject such as `education`.
    topic: Type.String({ minLength: 1, maxLength: 200 }),
    essay: Type.String({ minLength: 1, maxLength: 20_000 }),
    language: Type.Optional(LanguageSchema),
  },
  { additionalProperties: false },
);

export type GradeTask2Request = Static<typeof GradeTask2RequestSchema>;

/**
 * `criteria` is an array rather than four fixed fields because Task 1 and
 * Task 2 differ in their first criterion. A stable `id` lets one client
 * component render both tasks. Order is part of the contract.
 */
export const GradeResponseSchema = Type.Object(
  {
    overall_band: BandSchema,
    language: LanguageSchema,
    criteria: Type.Array(
      Type.Object(
        {
          id: CriterionIdSchema,
          name: Type.String(),
          band: BandSchema,
          band_reason: Type.String(),
          strengths: Type.Array(Type.String()),
          improvements: Type.Array(Type.String()),
        },
        { additionalProperties: false },
      ),
      { minItems: 4, maxItems: 4 },
    ),
    summary: Type.String(),
    suggestions: Type.Array(Type.String()),
    next_steps: Type.Array(Type.String()),
    // Commentary anchored to a quote from the essay. Not a replacement
    // suggestion: downstream returns `{quote, explanation}`, never a rewrite.
    annotations: Type.Array(
      Type.Object(
        {
          criterion: CriterionIdSchema,
          issue: Type.String(),
          quote: Type.String(),
          explanation: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type GradeResponse = Static<typeof GradeResponseSchema>;

export function decodeGradeResponse(value: unknown): GradeResponse {
  if (!Value.Check(GradeResponseSchema, value)) {
    throw new Error('stored Writing grading response is malformed');
  }
  return Value.Parse(GradeResponseSchema, value);
}

export { BandSchema, CriterionIdSchema, LanguageSchema };
