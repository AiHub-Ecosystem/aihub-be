import { Type } from '@sinclair/typebox';

export const PracticeTestsQuerySchema = Type.Object(
  {
    page: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
    page_size: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
  },
  { additionalProperties: false },
);

export const PracticeTestBaseItemSchema = {
  id: Type.Integer(),
  card_id: Type.String(),
  test_id: Type.Integer(),
  parts: Type.Array(Type.Integer()),
  title: Type.String(),
  source: Type.String(),
  total_questions: Type.Integer(),
  estimated_minutes: Type.Integer(),
  difficulty: Type.String(),
  unit: Type.String(),
  question_types: Type.Array(Type.String()),
  user_attempt_count: Type.Integer(),
};

export const PracticeTestsPaginationEnvelope = {
  total_count: Type.Optional(Type.Integer()),
  page: Type.Optional(Type.Integer()),
  page_size: Type.Optional(Type.Integer()),
  total_pages: Type.Optional(Type.Integer()),
  done_count: Type.Optional(Type.Integer()),
  not_done_count: Type.Optional(Type.Integer()),
};
