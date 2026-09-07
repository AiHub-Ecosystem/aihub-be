import { Value } from '@sinclair/typebox/value';

import {
  ContractNotReadyError,
  GradeTask1RequestSchema,
  GradeTask2RequestSchema,
  Task1QuestionRequestSchema,
  Task2QuestionRequestSchema,
  parseGradeResponse,
} from './grading';

describe('Writing contracts', () => {
  it('requires image_url for public Task1 grading and rejects downstream url', () => {
    expect(
      Value.Check(GradeTask1RequestSchema, {
        question: 'Describe the chart',
        image_url: 'https://example.com/chart.png',
        topic: 'Work',
        essay: 'A long enough essay.',
      }),
    ).toBe(true);

    expect(
      Value.Check(GradeTask1RequestSchema, {
        question: 'Describe the chart',
        url: 'https://example.com/chart.png',
        topic: 'Work',
        essay: 'A long enough essay.',
      }),
    ).toBe(false);
  });

  it('forbids image_url on public Task2 grading', () => {
    expect(
      Value.Check(GradeTask2RequestSchema, {
        question: 'Discuss remote work',
        topic: 'Work',
        essay: 'A long enough essay.',
      }),
    ).toBe(true);

    expect(
      Value.Check(GradeTask2RequestSchema, {
        question: 'Discuss remote work',
        topic: 'Work',
        essay: 'A long enough essay.',
        image_url: 'https://example.com/chart.png',
      }),
    ).toBe(false);
  });

  it('keeps question-generation schemas separate', () => {
    expect(Value.Check(Task1QuestionRequestSchema, {})).toBe(true);
    expect(Value.Check(Task1QuestionRequestSchema, { topic: 'Work' })).toBe(
      true,
    );
    expect(
      Value.Check(Task1QuestionRequestSchema, { question_type: 'opinion' }),
    ).toBe(false);

    expect(
      Value.Check(Task2QuestionRequestSchema, {
        topic: 'Work',
        question_type: 'opinion',
      }),
    ).toBe(true);
    expect(Value.Check(Task2QuestionRequestSchema, { topic: 'Work' })).toBe(
      false,
    );
  });

  it('refuses to parse the unresolved grading response contract', () => {
    expect(() => parseGradeResponse({})).toThrow(ContractNotReadyError);
  });
});
