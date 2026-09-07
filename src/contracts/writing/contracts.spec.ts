import { Value } from '@sinclair/typebox/value';

import {
  GradeTask1RequestSchema,
  GradeTask2RequestSchema,
  Task1QuestionRequestSchema,
  Task2QuestionRequestSchema,
} from './grading';

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

  it('keeps question-generation schemas separate', () => {
    expect(Value.Check(Task1QuestionRequestSchema, {})).toBe(true);
    expect(
      Value.Check(Task1QuestionRequestSchema, { chart_type: 'Line Graph' }),
    ).toBe(true);
    expect(
      Value.Check(Task1QuestionRequestSchema, { topic: 'environment' }),
    ).toBe(false);
    expect(
      Value.Check(Task1QuestionRequestSchema, { question_type: 'opinion' }),
    ).toBe(false);

    expect(
      Value.Check(Task2QuestionRequestSchema, {
        topic: 'education',
        question_type: 'opinion',
      }),
    ).toBe(true);
    expect(
      Value.Check(Task2QuestionRequestSchema, { topic: 'education' }),
    ).toBe(false);
  });
});
