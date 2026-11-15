import {
  NextCursorSchema,
  ResponseMetaSchema,
} from '@/contracts/response-meta';
import { type Static, Type } from '@sinclair/typebox';

export const SpeakingLibraryTopicItemSchema = Type.Object(
  {
    id: Type.Integer(),
    original_id: Type.Integer(),
    topic: Type.String(),
    subtopic: Type.String(),
    part: Type.Integer(),
    difficulty: Type.String(),
    permanent_topic: Type.Boolean(),
    source: Type.String(),
    questions: Type.Array(Type.String()),
    created_at: Type.String(),
    image_url: Type.Optional(Type.String()),
    forecast: Type.Optional(Type.String()),
    topic_type: Type.Optional(Type.String()),
    cue_card: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const SpeakingLibraryResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        topics: Type.Array(SpeakingLibraryTopicItemSchema),
        next_cursor: NextCursorSchema,
      },
      { additionalProperties: false },
    ),
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);

export type SpeakingLibraryResponse = Static<
  typeof SpeakingLibraryResponseSchema
>;
