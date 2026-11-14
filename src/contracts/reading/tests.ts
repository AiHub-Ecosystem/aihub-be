import {
  PracticeTestBaseItemSchema,
  PracticeTestsPaginationEnvelope,
  PracticeTestsQuerySchema,
} from '@/contracts/practice/test-collection';
import { type Static, Type } from '@sinclair/typebox';

export const ReadingTestsQuerySchema = PracticeTestsQuerySchema;

const ReadingTestItemSchema = Type.Object(
  {
    ...PracticeTestBaseItemSchema,
    word_count: Type.Optional(Type.Integer()),
    thumbnail_url: Type.Optional(Type.String()),
    passage_id: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

export const ReadingTestsResponseSchema = Type.Object(
  {
    items: Type.Array(ReadingTestItemSchema),
    ...PracticeTestsPaginationEnvelope,
  },
  { additionalProperties: false },
);

export type ReadingTestsQuery = Static<typeof ReadingTestsQuerySchema>;
export type ReadingTestsResponse = Static<typeof ReadingTestsResponseSchema>;
