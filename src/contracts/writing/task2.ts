import { type Static, Type } from '@sinclair/typebox';

export const QUESTION_TYPES = [
  'opinion',
  'discussion',
  'problem_solution',
  'advantages_disadvantages',
  'two_part',
] as const;

export const Task2QuestionRequestSchema = Type.Object(
  {
    topic: Type.String({ minLength: 1, maxLength: 200 }),
    question_type: Type.Union(
      QUESTION_TYPES.map((value) => Type.Literal(value)),
    ),
  },
  { additionalProperties: false },
);

export type Task2QuestionRequest = Static<typeof Task2QuestionRequestSchema>;

export const Task2QuestionResponseSchema = Type.Object(
  {
    question: Type.String(),
    topic: Type.String(),
    question_type: Type.Union(
      QUESTION_TYPES.map((value) => Type.Literal(value)),
    ),
  },
  { additionalProperties: false },
);

export type Task2QuestionResponse = Static<typeof Task2QuestionResponseSchema>;
