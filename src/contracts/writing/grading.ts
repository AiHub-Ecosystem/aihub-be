import { type Static, Type } from '@sinclair/typebox';

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

export const TASK1_IMAGE_URL_MAX_LENGTH = 2_000;

/**
 * TypeBox counts `maxLength` in UTF-16 code units, the unit of JavaScript's
 * `length`. JSON Schema counts code points, so the published limit says which
 * one AIHUB applies (#847). Counting units is never looser than counting code
 * points, so a text AIHUB accepts also fits a provider that counts either way.
 */
const LENGTH_UNIT_NOTE =
  'The limit counts UTF-16 code units. A character outside the Basic Multilingual Plane, such as most emoji, counts as 2.';

export type CriterionId = (typeof CRITERION_IDS)[number];

const CriterionIdSchema = Type.Union(
  CRITERION_IDS.map((value) => Type.Literal(value)),
);

export const GradeTask1RequestSchema = Type.Object(
  {
    question: Type.String({
      minLength: 1,
      maxLength: 2_000,
      description: LENGTH_UNIT_NOTE,
    }),
    chart_type: ChartTypeSchema,
    essay: Type.String({
      minLength: 1,
      maxLength: 20_000,
      description: LENGTH_UNIT_NOTE,
    }),
    image_url: Type.String({
      format: 'uri',
      pattern: '^[hH][tT][tT][pP][sS]://',
      maxLength: TASK1_IMAGE_URL_MAX_LENGTH,
      description:
        'HTTPS URL without userinfo or a non-443 port. IP literals must be public, and host names must be able to be public (no single-label, localhost, .local, .home.arpa, or .internal names); resolved addresses are checked by AI Writing.',
    }),
    language: Type.Optional(LanguageSchema),
  },
  { additionalProperties: false },
);

export type GradeTask1Request = Static<typeof GradeTask1RequestSchema>;

export const GradeTask2RequestSchema = Type.Object(
  {
    question: Type.String({
      minLength: 1,
      maxLength: 2_000,
      description: LENGTH_UNIT_NOTE,
    }),
    // Unlike Task 1, this really is a subject such as `education`.
    topic: Type.String({
      minLength: 1,
      maxLength: 200,
      description: LENGTH_UNIT_NOTE,
    }),
    essay: Type.String({
      minLength: 1,
      maxLength: 20_000,
      description: LENGTH_UNIT_NOTE,
    }),
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

export { BandSchema, CriterionIdSchema, LanguageSchema };
