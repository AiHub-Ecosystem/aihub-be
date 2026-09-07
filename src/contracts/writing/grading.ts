import { type Static, Type } from '@sinclair/typebox';

export {
  Task1QuestionRequestSchema,
  Task1QuestionResponseSchema,
} from './task1';
export {
  QUESTION_TYPES,
  Task2QuestionRequestSchema,
  Task2QuestionResponseSchema,
} from './task2';

export const GradeTask1RequestSchema = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 2_000 }),
    topic: Type.String({ minLength: 1, maxLength: 200 }),
    essay: Type.String({ minLength: 1, maxLength: 20_000 }),
    image_url: Type.String({ format: 'uri', maxLength: 2_000 }),
  },
  { additionalProperties: false },
);

export type GradeTask1Request = Static<typeof GradeTask1RequestSchema>;

export const GradeTask2RequestSchema = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 2_000 }),
    topic: Type.String({ minLength: 1, maxLength: 200 }),
    essay: Type.String({ minLength: 1, maxLength: 20_000 }),
  },
  { additionalProperties: false },
);

export type GradeTask2Request = Static<typeof GradeTask2RequestSchema>;

export class ContractNotReadyError extends Error {
  constructor() {
    super('Writing grading response contract is not ready');
    this.name = 'ContractNotReadyError';
  }
}

export function parseGradeResponse(_raw: unknown): never {
  throw new ContractNotReadyError();
}
