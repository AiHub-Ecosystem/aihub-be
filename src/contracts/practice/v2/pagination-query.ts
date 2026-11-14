import { Type } from '@sinclair/typebox';

export const PracticeContentPaginationQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
    cursor: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
