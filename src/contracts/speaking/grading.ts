import { FormatRegistry, type Static, Type } from '@sinclair/typebox';

if (!FormatRegistry.Has('binary')) {
  FormatRegistry.Set('binary', (value) => typeof value === 'string');
}

export const SpeakingGradeRequestSchema = Type.Object(
  {
    audio: Type.String({ format: 'binary' }),
    part: Type.Integer({ minimum: 1, maximum: 3 }),
    question_id: Type.String({ minLength: 1 }),
    prompt_text: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { default: null }),
    ),
    test_type: Type.Optional(
      Type.Union([Type.Literal('Practice'), Type.Literal('Full-test')], {
        default: 'Practice',
      }),
    ),
    test_code: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { default: null }),
    ),
    transcript: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { default: null }),
    ),
  },
  { additionalProperties: false },
);

export type SpeakingGradeRequestContract = Static<
  typeof SpeakingGradeRequestSchema
>;

export interface SpeakingAudio {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
}

export interface SpeakingGradeInput {
  readonly audio: SpeakingAudio;
  readonly part: number;
  readonly questionId: string;
  readonly promptText?: string;
  readonly testType?: string;
  readonly testCode?: string;
  readonly transcript?: string;
}

const BandSchema = Type.Number({
  minimum: 0,
  maximum: 9,
  multipleOf: 0.5,
});

const ScoreSchema = Type.Number({ minimum: 0, maximum: 100 });
const NonNegativeNumberSchema = Type.Number({ minimum: 0 });
const NullableNonNegativeNumberSchema = Type.Union([
  NonNegativeNumberSchema,
  Type.Null(),
]);
const NullableNonNegativeIntegerSchema = Type.Union([
  Type.Integer({ minimum: 0 }),
  Type.Null(),
]);

const ScorabilitySchema = Type.Object(
  {
    is_scorable: Type.Boolean(),
    confidence: Type.String(),
    display_band: Type.Boolean(),
    message_vi: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

const EstimatedBandSchema = Type.Object(
  {
    overall: BandSchema,
    fluency_coherence: BandSchema,
    lexical_resource: BandSchema,
    grammatical_range_accuracy: BandSchema,
    pronunciation: BandSchema,
  },
  { additionalProperties: false },
);

const TranscriptSchema = Type.Object(
  {
    text: Type.String(),
    word_count: Type.Integer({ minimum: 0 }),
    duration_seconds: NonNegativeNumberSchema,
  },
  { additionalProperties: false },
);

const RelevanceSchema = Type.Object(
  {
    on_topic: Type.Boolean(),
    score: Type.Number({ minimum: 0, maximum: 1 }),
    feedback_vi: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

const FluencyMetricsValueSchema = Type.Object(
  {
    speech_rate_wpm: NullableNonNegativeNumberSchema,
    pause_count: NullableNonNegativeIntegerSchema,
    mean_length_run_words: NullableNonNegativeNumberSchema,
  },
  { additionalProperties: false },
);
const FluencyMetricsSchema = Type.Union([
  FluencyMetricsValueSchema,
  Type.Null(),
]);

const AudioExtentSchema = Type.Tuple([
  Type.Integer({ minimum: 0 }),
  Type.Integer({ minimum: 0 }),
]);

const SyllableSchema = Type.Object(
  {
    letters: Type.String(),
    stress_level: Type.Union([
      Type.Integer({ minimum: 0, maximum: 2 }),
      Type.Null(),
    ]),
    predicted_stress: Type.Integer({ minimum: 0, maximum: 2 }),
    stress_score: ScoreSchema,
    quality_score: ScoreSchema,
    audio_extent_ms: AudioExtentSchema,
  },
  { additionalProperties: false },
);

const PhonemeSchema = Type.Object(
  {
    phone: Type.String(),
    quality_score: ScoreSchema,
    sound_most_like: Type.String(),
    stress_level: Type.Union([
      Type.Integer({ minimum: 0, maximum: 2 }),
      Type.Null(),
    ]),
    audio_extent_ms: AudioExtentSchema,
    char_index: Type.Array(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const PronunciationWordSchema = Type.Object(
  {
    word: Type.String(),
    quality_score: ScoreSchema,
    quality_class: Type.String(),
    syllables: Type.Array(SyllableSchema),
    phonemes: Type.Array(PhonemeSchema),
  },
  { additionalProperties: false },
);

const PronunciationDetailSchema = Type.Object(
  {
    summary: Type.Object(
      {
        good_count: Type.Integer({ minimum: 0 }),
        fair_count: Type.Integer({ minimum: 0 }),
        poor_count: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    words: Type.Array(PronunciationWordSchema),
  },
  { additionalProperties: false },
);

const GrammarErrorSchema = Type.Object(
  {
    sentence: Type.String(),
    error_segment: Type.String(),
    correction: Type.String(),
    error_type: Type.String(),
    explanation_vi: Type.String(),
  },
  { additionalProperties: false },
);

const VocabularyUpgradeSchema = Type.Object(
  {
    original_word: Type.String(),
    suggested_word: Type.String(),
    cefr_level: Type.String(),
    context: Type.Optional(Type.String()),
    reason_vi: Type.String(),
  },
  { additionalProperties: false },
);

const LanguageAnalysisSchema = Type.Object(
  {
    grammar_errors: Type.Array(GrammarErrorSchema),
    vocabulary_upgrades: Type.Array(VocabularyUpgradeSchema),
  },
  { additionalProperties: false },
);

const FeedbackSchema = Type.Object(
  {
    summary_vi: Type.String(),
    strong_point_vi: Type.String(),
    action_plan_vi: Type.String(),
  },
  { additionalProperties: false },
);

export const SpeakingGradeResponseSchema = Type.Object(
  {
    test_type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    question_id: Type.String({ minLength: 1 }),
    scorability: ScorabilitySchema,
    estimated_band: EstimatedBandSchema,
    transcript: TranscriptSchema,
    relevance: RelevanceSchema,
    fluency_metrics: FluencyMetricsSchema,
    pronunciation_detail: PronunciationDetailSchema,
    language_analysis: LanguageAnalysisSchema,
    feedback: FeedbackSchema,
  },
  { additionalProperties: false },
);

export type SpeakingGradeResponse = Static<typeof SpeakingGradeResponseSchema>;
