import { type Static, Type } from '@sinclair/typebox';

export const QUESTION_TYPES = [
  'opinion',
  'discussion',
  'problem_solution',
  'advantages_disadvantages',
  'two_part',
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

const QuestionTypeSchema = Type.Union(
  QUESTION_TYPES.map((value) => Type.Literal(value)),
);

export const Task2QuestionRequestSchema = Type.Object(
  {
    // A real subject here, unlike the Task 1 `chart_type`.
    topic: Type.String({ minLength: 1, maxLength: 200 }),
    question_type: QuestionTypeSchema,
  },
  { additionalProperties: false },
);

export type Task2QuestionRequest = Static<typeof Task2QuestionRequestSchema>;

export const Task2QuestionResponseSchema = Type.Object(
  {
    question: Type.String(),
    // Downstream does not echo the topic, so the adapter fills in an empty
    // string rather than dropping the field from the public contract.
    topic: Type.String(),
    question_type: QuestionTypeSchema,
  },
  { additionalProperties: false },
);

export type Task2QuestionResponse = Static<typeof Task2QuestionResponseSchema>;

export { QuestionTypeSchema };
