import { type Static, Type } from '@sinclair/typebox';

export const SpeakingV2TestTypeSchema = Type.Union([
  Type.Literal('practice'),
  Type.Literal('full_test'),
]);

export const SpeakingV2ScoresSchema = Type.Object(
  {
    overall: Type.Number({ minimum: 0, maximum: 9, multipleOf: 0.5 }),
    fluency_coherence: Type.Integer({ minimum: 0, maximum: 9 }),
    lexical_resource: Type.Integer({ minimum: 0, maximum: 9 }),
    grammatical_range_accuracy: Type.Integer({ minimum: 0, maximum: 9 }),
    pronunciation: Type.Integer({ minimum: 0, maximum: 9 }),
    is_provisional: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const SpeakingV2FeedbackSchema = Type.Object(
  {
    overview_vi: Type.String(),
    details: Type.Array(
      Type.Object(
        { criterion: Type.String(), comment_vi: Type.String() },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

// A word the provider could not align to the audio has no timing.
const SpeakingV2TimingMsSchema = Type.Union([
  Type.Number({ minimum: 0 }),
  Type.Null(),
]);

const SpeakingV2DiagnosticSchema = Type.Object(
  {
    reference: Type.Object(
      {
        token_range: Type.Array(Type.Integer({ minimum: 0 }), {
          minItems: 2,
          maxItems: 2,
        }),
        text: Type.String(),
        start_ms: SpeakingV2TimingMsSchema,
        end_ms: SpeakingV2TimingMsSchema,
      },
      { additionalProperties: false },
    ),
    kind: Type.String(),
    // A finding the language check could not classify carries null codes or
    // advice; a real recording returned null `error_codes`.
    error_codes: Type.Union([Type.String(), Type.Null()]),
    explain_vi: Type.Union([Type.String(), Type.Null()]),
    improvement: Type.Union([Type.String(), Type.Null()]),
    improvement_vi: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

const SpeakingV2CriterionSchema = Type.Object(
  {
    summary: Type.Object(
      {
        reason_for_band_vi: Type.String(),
        strengths_vi: Type.Array(Type.String()),
        areas_for_improvement_vi: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    // Located findings exist on a question result; Part and Test results are
    // aggregates and carry `null` here.
    diagnostics: Type.Union([
      Type.Null(),
      Type.Array(SpeakingV2DiagnosticSchema),
    ]),
  },
  { additionalProperties: false },
);

export const SpeakingV2CriteriaSchema = Type.Object(
  {
    fluency_coherence: SpeakingV2CriterionSchema,
    lexical_resource: SpeakingV2CriterionSchema,
    grammatical_range_accuracy: SpeakingV2CriterionSchema,
    pronunciation: SpeakingV2CriterionSchema,
  },
  { additionalProperties: false },
);

export const SpeakingV2TranscriptSchema = Type.Object(
  {
    text: Type.String(),
    stats: Type.Object(
      {
        word_count: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        speaking_seconds: Type.Union([
          Type.Number({ minimum: 0 }),
          Type.Null(),
        ]),
      },
      { additionalProperties: false },
    ),
    // `diagnostics[].reference.token_range` indexes into these tokens.
    tokens: Type.Array(
      Type.Object(
        {
          index: Type.Integer({ minimum: 0 }),
          text: Type.String(),
          start_ms: SpeakingV2TimingMsSchema,
          end_ms: SpeakingV2TimingMsSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type SpeakingV2TestType = Static<typeof SpeakingV2TestTypeSchema>;
