import { type Static, Type } from '@sinclair/typebox';

export const WritingTemplateTaskTypeSchema = Type.Union([
  Type.Literal('task 1'),
  Type.Literal('task 2'),
]);

// Headers carry far more than this route reads, so only the one it needs is
// declared and the rest are allowed through.
export const WritingTemplateHeadersSchema = Type.Object(
  { 'x-task-type': WritingTemplateTaskTypeSchema },
  { additionalProperties: true },
);

export const WritingTemplateQuerySchema = Type.Object(
  {},
  { additionalProperties: false },
);

// The legacy item also carries the author's `userId` and `userName`; they are
// left out so the public response names no account (presentation rules).
const WritingTemplateItemSchema = Type.Object(
  {
    taskType: Type.String(),
    id: Type.Integer(),
    question: Type.String(),
    typeId: Type.Integer(),
    typeName: Type.String(),
    sourceId: Type.Integer(),
    sourceName: Type.String(),
    imageAnalysisStatus: Type.Boolean(),
    attemptCount: Type.Integer(),
    title: Type.Optional(Type.String()),
    questionType: Type.Optional(Type.String()),
    subtype: Type.Optional(Type.String()),
    image: Type.Optional(Type.String()),
    sourceDetail: Type.Optional(Type.String()),
    examDate: Type.Optional(Type.String()),
    topic: Type.Optional(Type.String()),
    difficulty: Type.Optional(Type.String()),
    bookId: Type.Optional(Type.Integer()),
    bookName: Type.Optional(Type.String()),
    testId: Type.Optional(Type.Integer()),
    testName: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WritingTemplateListResponseSchema = Type.Array(
  WritingTemplateItemSchema,
);

export type WritingTemplateTaskType = Static<
  typeof WritingTemplateTaskTypeSchema
>;
export type WritingTemplateListResponse = Static<
  typeof WritingTemplateListResponseSchema
>;
