import { type Static, Type } from '@sinclair/typebox';

import { CriterionIdSchema } from '@/contracts/writing/grading';

export const MICRO_EXERCISE_TYPES = [
  'multiple_choice_single',
  'multiple_choice_multiple',
  'choose_from_list',
  'gap_filling',
  'annotation',
  'reorder',
  'short_writing',
] as const;

export type MicroExerciseType = (typeof MICRO_EXERCISE_TYPES)[number];

const MicroExerciseTypeSchema = Type.Union(
  MICRO_EXERCISE_TYPES.map((type) => Type.Literal(type)),
);

export const WRITING_EXERCISE_IMAGE_URL_MAX_LENGTH = 2_048;

const ErrorCodeSchema = Type.String({
  minLength: 1,
  description:
    'Provider-owned informational code; clients must tolerate new or renamed values.',
});

const CommentSchema = Type.Object(
  {
    quote: Type.String({ minLength: 1, maxLength: 1_000 }),
    explanation: Type.String({ minLength: 1, maxLength: 1_000 }),
  },
  { additionalProperties: false },
);

export const WritingExerciseErrorSchema = Type.Object(
  {
    criterion: CriterionIdSchema,
    error_code: ErrorCodeSchema,
    prompt: Type.String({ minLength: 1, maxLength: 2_000 }),
    question_type: Type.String({ minLength: 1 }),
    image_url: Type.Optional(
      Type.Union([
        Type.String({
          minLength: 1,
          maxLength: WRITING_EXERCISE_IMAGE_URL_MAX_LENGTH,
        }),
        Type.Null(),
      ]),
    ),
    comments: Type.Array(CommentSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type WritingExerciseError = Static<typeof WritingExerciseErrorSchema>;

const ExerciseSelection = {
  topic: Type.String({ minLength: 1, maxLength: 200 }),
  writing_task: Type.Union([Type.Literal(1), Type.Literal(2)]),
};

export const CreateMicroExerciseRequestSchema = Type.Object(
  {
    ...ExerciseSelection,
    ...WritingExerciseErrorSchema.properties,
    exercise_type: Type.Optional(
      Type.Union([MicroExerciseTypeSchema, Type.Null()]),
    ),
  },
  { additionalProperties: false },
);

export type CreateMicroExerciseRequest = Static<
  typeof CreateMicroExerciseRequestSchema
>;

export const CreateLongWritingExerciseRequestSchema = Type.Object(
  {
    ...ExerciseSelection,
    errors: Type.Array(WritingExerciseErrorSchema, {
      minItems: 2,
      maxItems: 4,
    }),
  },
  { additionalProperties: false },
);

export type CreateLongWritingExerciseRequest = Static<
  typeof CreateLongWritingExerciseRequestSchema
>;

const GradeFields = {
  instruction: Type.String({ minLength: 1 }),
  question_no: Type.Integer({ minimum: 1 }),
  question_text: Type.String({ minLength: 1 }),
  question_image: Type.Union([
    Type.String({
      minLength: 1,
      maxLength: WRITING_EXERCISE_IMAGE_URL_MAX_LENGTH,
    }),
    Type.Null(),
  ]),
  hint: Type.Array(Type.String()),
  sample_answer: Type.String({ minLength: 1 }),
  ai_grading_rubric: Type.String({ minLength: 1 }),
  note: Type.Optional(Type.Union([Type.String(), Type.Null()])),
};

export const GradeMicroExerciseRequestSchema = Type.Union([
  Type.Object(
    {
      exercise_type: Type.Literal('short_writing'),
      ...GradeFields,
      user_answer: Type.String({ minLength: 1, maxLength: 1_500 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      exercise_type: Type.Literal('long_writing'),
      ...GradeFields,
      user_answer: Type.String({ minLength: 1, maxLength: 4_000 }),
    },
    { additionalProperties: false },
  ),
]);

export type GradeMicroExerciseRequest = Static<
  typeof GradeMicroExerciseRequestSchema
>;

const StringList = Type.Array(Type.String());

const ExerciseItemFields = {
  questions_no: Type.Integer({ minimum: 1 }),
  question_text: Type.String(),
  question_image: Type.Union([
    Type.String({ maxLength: WRITING_EXERCISE_IMAGE_URL_MAX_LENGTH }),
    Type.Null(),
  ]),
  explanation: Type.String(),
};

const MicroMetaFields = {
  id: Type.String({ minLength: 1 }),
  ai_grading: Type.String(),
  difficulty: Type.String(),
  topic: Type.String(),
  instruction: Type.String(),
  number_of_questions: Type.Integer({ minimum: 1 }),
  rationale_for_exercise: Type.Union([Type.String(), Type.Null()]),
};

const MicroResponseData = <
  TType extends MicroExerciseType,
  TItem extends ReturnType<typeof Type.Object>,
>(
  type: TType,
  item: TItem,
) =>
  Type.Object(
    {
      meta: Type.Object(
        {
          ...MicroMetaFields,
          type: Type.Literal(type),
          error_code: Type.String(),
        },
        { additionalProperties: false },
      ),
      exercise: Type.Array(item, { minItems: 1 }),
    },
    { additionalProperties: false },
  );

const MultipleChoiceOptions = Type.Object(
  {
    A: Type.String(),
    B: Type.String(),
    C: Type.String(),
    D: Type.String(),
  },
  { additionalProperties: false },
);

const MultipleChoiceSingle = MicroResponseData(
  'multiple_choice_single',
  Type.Object(
    {
      ...ExerciseItemFields,
      options: MultipleChoiceOptions,
      correct: Type.String(),
    },
    { additionalProperties: false },
  ),
);

const MultipleChoiceMultiple = MicroResponseData(
  'multiple_choice_multiple',
  Type.Object(
    {
      ...ExerciseItemFields,
      options: MultipleChoiceOptions,
      correct: Type.Array(Type.String(), { minItems: 1, maxItems: 4 }),
    },
    { additionalProperties: false },
  ),
);

const ChooseFromList = MicroResponseData(
  'choose_from_list',
  Type.Object(
    {
      ...ExerciseItemFields,
      options: Type.Array(Type.String(), { minItems: 2 }),
      correct: Type.String(),
    },
    { additionalProperties: false },
  ),
);

const GapFilling = MicroResponseData(
  'gap_filling',
  Type.Object(
    {
      ...ExerciseItemFields,
      correct: StringList,
    },
    { additionalProperties: false },
  ),
);

const Annotation = MicroResponseData(
  'annotation',
  Type.Object(
    {
      ...ExerciseItemFields,
      text_for_annotation: Type.String(),
      correct: StringList,
    },
    { additionalProperties: false },
  ),
);

const Reorder = MicroResponseData(
  'reorder',
  Type.Object(
    {
      ...ExerciseItemFields,
      options: Type.Array(Type.String(), { minItems: 2 }),
      correct: Type.String(),
    },
    { additionalProperties: false },
  ),
);

const OpenWritingAnswer = Type.Object(
  {
    sample_answer: Type.String(),
    ai_grading_rubric: Type.String(),
    note: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

const ShortWriting = MicroResponseData(
  'short_writing',
  Type.Object(
    {
      ...ExerciseItemFields,
      hint: StringList,
      correct: OpenWritingAnswer,
    },
    { additionalProperties: false },
  ),
);

export const MICRO_EXERCISE_RESPONSE_SCHEMAS = {
  multiple_choice_single: MultipleChoiceSingle,
  multiple_choice_multiple: MultipleChoiceMultiple,
  choose_from_list: ChooseFromList,
  gap_filling: GapFilling,
  annotation: Annotation,
  reorder: Reorder,
  short_writing: ShortWriting,
} as const;

export const MicroExerciseResponseSchema = Type.Union([
  MICRO_EXERCISE_RESPONSE_SCHEMAS.multiple_choice_single,
  MICRO_EXERCISE_RESPONSE_SCHEMAS.multiple_choice_multiple,
  MICRO_EXERCISE_RESPONSE_SCHEMAS.choose_from_list,
  MICRO_EXERCISE_RESPONSE_SCHEMAS.gap_filling,
  MICRO_EXERCISE_RESPONSE_SCHEMAS.annotation,
  MICRO_EXERCISE_RESPONSE_SCHEMAS.reorder,
  MICRO_EXERCISE_RESPONSE_SCHEMAS.short_writing,
]);

export type MicroExerciseResponse = Static<typeof MicroExerciseResponseSchema>;

const LongWritingExerciseResponse = Type.Object(
  {
    meta: Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        type: Type.Literal('long_writing'),
        ai_grading: Type.String(),
        error_code: StringList,
        difficulty: Type.String(),
        topic: Type.String(),
        instruction: Type.String(),
        number_of_questions: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    exercise: Type.Array(
      Type.Object(
        {
          ...ExerciseItemFields,
          hint: StringList,
          correct: Type.Object(
            {
              sample_answer: Type.String(),
              ai_grading_rubric: Type.String(),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

export const LongWritingExerciseResponseSchema = LongWritingExerciseResponse;
export type LongWritingExerciseResponse = Static<
  typeof LongWritingExerciseResponseSchema
>;

export const MicroExerciseGradeResponseSchema = Type.Object(
  {
    score: Type.Integer({ minimum: 1, maximum: 10 }),
    comment: Type.String(),
  },
  { additionalProperties: false },
);

export type MicroExerciseGradeResponse = Static<
  typeof MicroExerciseGradeResponseSchema
>;
