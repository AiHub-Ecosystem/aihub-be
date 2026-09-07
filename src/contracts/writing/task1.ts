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

/**
 * Downstream calls this field `topic`, but the values are chart types, not
 * subjects: sending `"environment"` returns HTTP 500. Probed against the live
 * service on 2026-09-07 and confirmed case-sensitive (`"bar chart"` fails).
 */
export const CHART_TYPES = [
  'Bar Chart',
  'Line Graph',
  'Pie Chart',
  'Table',
  'Map',
  'Process Diagram',
  'Multiple Graphs',
] as const;

export type ChartType = (typeof CHART_TYPES)[number];

const ChartTypeSchema = Type.Union(
  CHART_TYPES.map((value) => Type.Literal(value)),
);

export const Task1QuestionRequestSchema = Type.Object(
  {
    // Omitting it draws a random question and is the most common call.
    chart_type: Type.Optional(ChartTypeSchema),
  },
  { additionalProperties: false },
);

export type Task1QuestionRequest = Static<typeof Task1QuestionRequestSchema>;

export const Task1QuestionResponseSchema = Type.Object(
  {
    question_id: Type.String(),
    question: Type.String(),
    chart_type: ChartTypeSchema,
    image_url: Type.String({ format: 'uri' }),
  },
  { additionalProperties: false },
);

export type Task1QuestionResponse = Static<typeof Task1QuestionResponseSchema>;

export { ChartTypeSchema };
