import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { GradeTask1RequestSchema, GradeTask2RequestSchema } from './grading';

const TASK1_GRADE = {
  question: 'Describe the chart',
  chart_type: 'Bar Chart',
  image_url: 'https://example.com/chart.png',
  essay: 'A long enough essay.',
};

describe('Writing contracts', () => {
  it('requires image_url for public Task1 grading and rejects downstream url', () => {
    expect(Value.Check(GradeTask1RequestSchema, TASK1_GRADE)).toBe(true);

    expect(
      Value.Check(GradeTask1RequestSchema, {
        ...TASK1_GRADE,
        image_url: undefined,
        url: 'https://example.com/chart.png',
      }),
    ).toBe(false);
  });

  it('requires Task 1 image URLs to use HTTPS while accepting any public host', () => {
    expect(
      Value.Check(GradeTask1RequestSchema, {
        ...TASK1_GRADE,
        image_url: 'https://charts.customer.example/chart.png',
      }),
    ).toBe(true);
    expect(
      Value.Check(GradeTask1RequestSchema, {
        ...TASK1_GRADE,
        image_url: 'HTTPS://charts.customer.example/chart.png',
      }),
    ).toBe(true);
    expect(
      Value.Check(GradeTask1RequestSchema, {
        ...TASK1_GRADE,
        image_url: 'http://charts.customer.example/chart.png',
      }),
    ).toBe(false);
    expect(
      Value.Check(GradeTask1RequestSchema, {
        ...TASK1_GRADE,
        image_url: 'ftp://charts.customer.example/chart.png',
      }),
    ).toBe(false);
  });

  it('accepts chart types exactly as the downstream stores them', () => {
    expect(
      Value.Check(GradeTask1RequestSchema, {
        ...TASK1_GRADE,
        chart_type: 'Process Diagram',
      }),
    ).toBe(true);

    // Downstream lookup is case-sensitive; a lowercase value 500s there.
    expect(
      Value.Check(GradeTask1RequestSchema, {
        ...TASK1_GRADE,
        chart_type: 'bar chart',
      }),
    ).toBe(false);

    // `chart_type` is a chart type, never a subject.
    expect(
      Value.Check(GradeTask1RequestSchema, {
        ...TASK1_GRADE,
        chart_type: 'environment',
      }),
    ).toBe(false);
  });

  it('forbids image_url and chart_type on public Task2 grading', () => {
    const task2 = {
      question: 'Discuss remote work',
      topic: 'education',
      essay: 'A long enough essay.',
    };

    expect(Value.Check(GradeTask2RequestSchema, task2)).toBe(true);

    expect(
      Value.Check(GradeTask2RequestSchema, {
        ...task2,
        image_url: 'https://example.com/chart.png',
      }),
    ).toBe(false);

    expect(
      Value.Check(GradeTask2RequestSchema, {
        ...task2,
        chart_type: 'Bar Chart',
      }),
    ).toBe(false);
  });

  it('accepts the optional feedback language on both grading operations', () => {
    expect(
      Value.Check(GradeTask1RequestSchema, { ...TASK1_GRADE, language: 'vi' }),
    ).toBe(true);

    // Downstream cannot produce English yet, so the enum stays closed.
    expect(
      Value.Check(GradeTask1RequestSchema, { ...TASK1_GRADE, language: 'en' }),
    ).toBe(false);
  });
});

// #847: a limit counts UTF-16 code units, the unit JavaScript's `length` uses.
// A character outside the Basic Multilingual Plane is one code point and two
// units, so it spends two of the limit.
const GRAPHEME = '😀';
const TASK2_GRADE = {
  question: 'Should schools provide more arts education?',
  topic: 'education',
  essay: 'A long enough essay.',
};
const TEXT_FIELDS = [
  ['Task 1 question', GradeTask1RequestSchema, TASK1_GRADE, 'question', 2_000],
  ['Task 1 essay', GradeTask1RequestSchema, TASK1_GRADE, 'essay', 20_000],
  ['Task 2 question', GradeTask2RequestSchema, TASK2_GRADE, 'question', 2_000],
  ['Task 2 topic', GradeTask2RequestSchema, TASK2_GRADE, 'topic', 200],
  ['Task 2 essay', GradeTask2RequestSchema, TASK2_GRADE, 'essay', 20_000],
] as const;

describe.each(TEXT_FIELDS)('%s length', (_name, schema, base, field, limit) => {
  it('counts UTF-16 code units, so a text at the limit in units is accepted', () => {
    const text = 'a'.repeat(limit - GRAPHEME.length) + GRAPHEME;

    expect(Value.Check(schema, { ...base, [field]: text })).toBe(true);
  });

  it('refuses a text under the limit in code points but over it in units', () => {
    const text = 'a'.repeat(limit - GRAPHEME.length + 1) + GRAPHEME;

    expect(Array.from(text).length).toBeLessThanOrEqual(limit);
    expect(text.length).toBeGreaterThan(limit);
    expect(Value.Check(schema, { ...base, [field]: text })).toBe(false);
  });

  it('states the unit in the published schema description', () => {
    const properties: Record<string, TSchema> = schema.properties;

    expect(properties[field]?.description).toMatch(/UTF-16 code units/);
  });
});
