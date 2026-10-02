import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Value } from '@sinclair/typebox/value';

import { AppError } from '@/common/errors/app-error';
import { GradeResponseSchema } from '@/contracts/writing/grading';
import { parseGradeResponse } from './grade-response.adapter';

const FIXTURES = join(__dirname, '../../../test/fixtures/ai-writing');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8'));
}

describe('parseGradeResponse', () => {
  it('maps a real Task 1 grading response onto the canonical contract', () => {
    const result = parseGradeResponse(fixture('grade-task1.response.json'));

    expect(Value.Check(GradeResponseSchema, result)).toBe(true);
    expect(result.overall_band).toBe(7);
    expect(result.language).toBe('vi');
    expect(result.criteria.map((criterion) => criterion.id)).toEqual([
      'task_achievement',
      'coherence_cohesion',
      'lexical_resource',
      'grammatical_range_accuracy',
    ]);
    expect(result.criteria[0]?.name).toBe('Task Achievement');
    expect(result.annotations[0]?.quote).toBe(
      'a more than twentyfold increase',
    );
  });

  it('maps a real Task 2 grading response with the task_response criterion', () => {
    const result = parseGradeResponse(fixture('grade-task2.response.json'));

    expect(Value.Check(GradeResponseSchema, result)).toBe(true);
    expect(result.criteria.map((criterion) => criterion.id)).toEqual([
      'task_response',
      'coherence_cohesion',
      'lexical_resource',
      'grammatical_range_accuracy',
    ]);
    expect(result.criteria[0]?.name).toBe('Task Response');
    expect(result.annotations.length).toBeGreaterThan(0);
  });

  it('never leaks the downstream chain-of-thought or its stringified feedback', () => {
    const raw = fixture('grade-task1.response.json');
    const serialised = JSON.stringify(parseGradeResponse(raw));

    expect(JSON.stringify(raw)).toContain('layer1_errors');
    expect(serialised).not.toContain('layer1_errors');
    expect(serialised).not.toContain('layer2_matching');
    expect(serialised).not.toContain('layer3_calibration');
    expect(serialised).not.toContain('feedback_detail');
  });

  it('turns the "None specified" sentinel into an empty list', () => {
    const result = parseGradeResponse({
      data: {
        overall_band: 6,
        evaluation: {
          '1_task_response': {
            band_score: 6,
            band_reason: 'reason',
            strengths: ['a strength'],
            areas_for_improvement: ['None specified'],
          },
          '2_coherence_cohesion': { band_score: 6 },
          '3_lexical_resource': { band_score: 6 },
          '4_grammatical_range_accuracy': { band_score: 6 },
        },
      },
    });

    expect(result.criteria[0]?.improvements).toEqual([]);
    expect(result.criteria[0]?.strengths).toEqual(['a strength']);
  });

  it('rejects a response whose criteria are missing or unknown', () => {
    expect(() => parseGradeResponse({ data: { overall_band: 7 } })).toThrow(
      AppError,
    );

    expect(() =>
      parseGradeResponse({
        data: {
          overall_band: 7,
          evaluation: { '1_unknown_criterion': { band_score: 7 } },
        },
      }),
    ).toThrow(AppError);
  });

  it('reports a contract violation rather than leaking the reason to the client', () => {
    let caught: unknown;
    try {
      parseGradeResponse({ data: { overall_band: 'seven' } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    const appError = caught as AppError;
    expect(appError.code).toBe('AI_SERVICE_CONTRACT_VIOLATION');
    expect(appError.httpStatus).toBe(502);
    expect(appError.retryable).toBe(false);
    expect(appError.message).not.toContain('overall_band');
  });
});
