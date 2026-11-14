import { type Static, Type } from '@sinclair/typebox';

export const SpeakingLibraryQuerySchema = Type.Object(
  {
    page: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
    pageSize: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
  },
  { additionalProperties: false },
);

const SpeakingLibraryItemSchema = Type.Object(
  {
    id: Type.Integer(),
    originalId: Type.Integer(),
    topic: Type.String(),
    subtopic: Type.String(),
    part: Type.Integer(),
    difficulty: Type.String(),
    permanentTopic: Type.Boolean(),
    source: Type.String(),
    questions: Type.Array(Type.String()),
    createdAt: Type.String(),
    imageUrl: Type.Optional(Type.String()),
    forecast: Type.Optional(Type.String()),
    topicType: Type.Optional(Type.String()),
    cueCard: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const SpeakingLibraryResponseSchema = Type.Object(
  {
    totalCount: Type.Integer(),
    page: Type.Integer(),
    pageSize: Type.Integer(),
    totalPages: Type.Integer(),
    items: Type.Array(SpeakingLibraryItemSchema),
  },
  { additionalProperties: false },
);

export type SpeakingLibraryQuery = Static<typeof SpeakingLibraryQuerySchema>;
export type SpeakingLibraryResponse = Static<
  typeof SpeakingLibraryResponseSchema
>;
