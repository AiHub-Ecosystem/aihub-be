import {
  NextCursorSchema,
  ResponseMetaSchema,
} from '@/contracts/response-meta';
import { type Static, Type } from '@sinclair/typebox';

const BaseWritingTemplateItemSchema = {
  id: Type.Integer(),
  question: Type.String(),
  type_id: Type.Integer(),
  type_name: Type.String(),
  source_id: Type.Integer(),
  source_name: Type.String(),
  image_analysis_status: Type.Boolean(),
  title: Type.Optional(Type.String()),
  question_type: Type.Optional(Type.String()),
  subtype: Type.Optional(Type.String()),
  source_detail: Type.Optional(Type.String()),
  exam_date: Type.Optional(Type.String()),
  topic: Type.Optional(Type.String()),
  difficulty: Type.Optional(Type.String()),
  book_id: Type.Optional(Type.Integer()),
  book_name: Type.Optional(Type.String()),
  test_id: Type.Optional(Type.Integer()),
  test_name: Type.Optional(Type.String()),
};

export const WritingTask1TemplateItemSchema = Type.Object(
  {
    task_type: Type.Literal('Task 1'),
    image_url: Type.String(),
    ...BaseWritingTemplateItemSchema,
  },
  { additionalProperties: false },
);

export const WritingTask1TemplatesResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        templates: Type.Array(WritingTask1TemplateItemSchema),
        next_cursor: NextCursorSchema,
      },
      { additionalProperties: false },
    ),
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);

export const WritingTask2TemplateItemSchema = Type.Object(
  {
    task_type: Type.Literal('Task 2'),
    ...BaseWritingTemplateItemSchema,
  },
  { additionalProperties: false },
);

export const WritingTask2TemplatesResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        templates: Type.Array(WritingTask2TemplateItemSchema),
        next_cursor: NextCursorSchema,
      },
      { additionalProperties: false },
    ),
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);

export type WritingTask1TemplatesResponse = Static<
  typeof WritingTask1TemplatesResponseSchema
>;
export type WritingTask2TemplatesResponse = Static<
  typeof WritingTask2TemplatesResponseSchema
>;
