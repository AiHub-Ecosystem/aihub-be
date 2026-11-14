import {
  NextCursorSchema,
  ResponseMetaSchema,
} from '@/contracts/response-meta';
import { type Static, Type } from '@sinclair/typebox';

const BasePracticeTestItemSchema = {
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
};

export const ListeningTestItemSchema = Type.Object(
  {
    ...BasePracticeTestItemSchema,
    test_ref: Type.Optional(Type.String()),
    section_number: Type.Optional(Type.Integer()),
    topic: Type.Optional(Type.String()),
    duration_seconds: Type.Optional(Type.Integer()),
    thumbnail_url: Type.Optional(Type.String()),
    audio_url: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ListeningTestsResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        tests: Type.Array(ListeningTestItemSchema),
        next_cursor: NextCursorSchema,
      },
      { additionalProperties: false },
    ),
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);

export const ReadingTestItemSchema = Type.Object(
  {
    ...BasePracticeTestItemSchema,
    word_count: Type.Optional(Type.Integer()),
    thumbnail_url: Type.Optional(Type.String()),
    passage_id: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

export const ReadingTestsResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        tests: Type.Array(ReadingTestItemSchema),
        next_cursor: NextCursorSchema,
      },
      { additionalProperties: false },
    ),
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);

export type ListeningTestsResponse = Static<
  typeof ListeningTestsResponseSchema
>;
export type ReadingTestsResponse = Static<typeof ReadingTestsResponseSchema>;
