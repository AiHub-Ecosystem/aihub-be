import { FormatRegistry, Type } from '@sinclair/typebox';

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

export { ChartTypeSchema };
