import {
  PracticeTestBaseItemSchema,
  PracticeTestsPaginationEnvelope,
  PracticeTestsQuerySchema,
} from '@/contracts/practice/test-collection';
import { type Static, Type } from '@sinclair/typebox';

export const ListeningTestsQuerySchema = PracticeTestsQuerySchema;

const ListeningTestItemSchema = Type.Object(
  {
    ...PracticeTestBaseItemSchema,
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
    items: Type.Array(ListeningTestItemSchema),
    ...PracticeTestsPaginationEnvelope,
  },
  { additionalProperties: false },
);

export type ListeningTestsQuery = Static<typeof ListeningTestsQuerySchema>;
export type ListeningTestsResponse = Static<
  typeof ListeningTestsResponseSchema
>;
