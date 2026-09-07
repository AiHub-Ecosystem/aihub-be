import { FormatRegistry, type Static, Type } from '@sinclair/typebox';

if (!FormatRegistry.Has('uri')) {
  FormatRegistry.Set('uri', (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  });
}

export const Task1QuestionRequestSchema = Type.Object(
  {
    topic: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

export type Task1QuestionRequest = Static<typeof Task1QuestionRequestSchema>;

export const Task1QuestionResponseSchema = Type.Object(
  {
    question: Type.String(),
    topic: Type.String(),
    image_url: Type.String({ format: 'uri' }),
  },
  { additionalProperties: false },
);

export type Task1QuestionResponse = Static<typeof Task1QuestionResponseSchema>;
