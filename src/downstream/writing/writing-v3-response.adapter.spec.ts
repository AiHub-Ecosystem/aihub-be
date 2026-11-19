import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Value } from '@sinclair/typebox/value';

import { isRecord } from '@/common/is-record';
import { WritingV2GradeResponseSchema } from '@/contracts/writing/v2/grading';
import { withWritingErrorPriorityCapture } from '../../../test/support/writing-error-priority-fixture';
import { parseWritingV3Response } from './writing-v3-response.adapter';

function fixture(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(
      resolve(process.cwd(), `test/fixtures/ai-writing/${name}`),
      'utf8',
    ),
  );
  if (!isRecord(parsed)) {
    throw new Error('fixture is not an object');
  }
  return parsed;
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('parseWritingV3Response', () => {
  it.each([
    ['grade-v3-task1.response.json', 'task_achievement', 1],
    ['grade-v3-task2.response.json', 'task_response', 2],
  ] as const)(
    'maps the captured %s onto the /v2 schema',
    (name, firstCriterion, task) => {
      const result = parseWritingV3Response(
        withWritingErrorPriorityCapture(fixture(name), task),
      );

      expect(Value.Check(WritingV2GradeResponseSchema, result)).toBe(true);
      expect(result.criteria.map((criterion) => criterion.id)).toEqual([
        firstCriterion,
        'coherence_cohesion',
        'lexical_resource',
        'grammatical_range_accuracy',
      ]);
      expect(result.error_priority).toEqual(
        (
          fixture(`grade-v3-task${task}-error-priority.capture.json`)[
            'data'
          ] as Record<string, unknown>
        )['error_priority'],
      );
    },
  );

  it.each([1, 2] as const)(
    'rejects a Task %i provider response without error_priority',
    (task) => {
      expect(
        thrownBy(() =>
          parseWritingV3Response(fixture(`grade-v3-task${task}.response.json`)),
        ),
      ).toMatchObject({ code: 'AI_SERVICE_CONTRACT_VIOLATION' });
    },
  );

  it.each([
    ['rank above the allowed range', { rank: 4 }],
    ['an unknown group', { group: 'task_response' }],
  ])('rejects error_priority with %s', (_label, override) => {
    const body = withWritingErrorPriorityCapture(
      fixture('grade-v3-task1.response.json'),
      1,
    );
    const data = body['data'] as Record<string, unknown>;
    const [first] = data['error_priority'] as Record<string, unknown>[];
    data['error_priority'] = [{ ...first, ...override }];

    expect(thrownBy(() => parseWritingV3Response(body))).toMatchObject({
      code: 'AI_SERVICE_CONTRACT_VIOLATION',
    });
  });

  it('ignores additive provider fields inside error_priority entries', () => {
    const body = withWritingErrorPriorityCapture(
      fixture('grade-v3-task1.response.json'),
      1,
    );
    const data = body['data'] as Record<string, unknown>;
    const [first] = data['error_priority'] as Record<string, unknown>[];
    data['error_priority'] = [
      { ...first, future_optional_field: 'provider extension' },
    ];

    const result = parseWritingV3Response(body);

    expect(result.error_priority[0]).toEqual(first);
    expect(result.error_priority[0]).not.toHaveProperty(
      'future_optional_field',
    );
    expect(Value.Check(WritingV2GradeResponseSchema, result)).toBe(true);
  });

  it('renames keys to snake_case and keeps provider strings verbatim, leading "- " included', () => {
    const body = fixture('grade-v3-task2.response.json');
    const result = parseWritingV3Response(
      withWritingErrorPriorityCapture(body, 2),
    );
    const data = body['data'] as {
      overall_band: number;
      'Overall Assessment': {
        Summary: { Overall: string; Detail: string[]; CTA: string };
        Progress: { status: string; error_new: string[] };
      };
    };

    expect(result.overall_band).toBe(data.overall_band);
    expect(result.overall_assessment.summary).toEqual({
      overall: data['Overall Assessment'].Summary.Overall,
      detail: data['Overall Assessment'].Summary.Detail,
      cta: data['Overall Assessment'].Summary.CTA,
    });
    expect(result.overall_assessment.summary.overall.startsWith('- ')).toBe(
      true,
    );
    expect(result.overall_assessment.progress.status).toBe(
      data['Overall Assessment'].Progress.status,
    );
    expect(result.overall_assessment.progress.error_new).toEqual(
      data['Overall Assessment'].Progress.error_new,
    );
  });

  it('carries each criterion errors and suggestions, and data_micro inside the result', () => {
    const body = fixture('grade-v3-task1.response.json');
    const result = parseWritingV3Response(
      withWritingErrorPriorityCapture(body, 1),
    );
    const lexical = result.criteria.find(
      (criterion) => criterion.id === 'lexical_resource',
    );

    expect(lexical?.errors.length).toBeGreaterThan(0);
    expect(Object.keys(lexical?.errors[0] ?? {}).sort()).toEqual([
      'error_codes',
      'error_name',
      'explanation',
      'improved_version',
      'quote',
    ]);
    expect(result.data_micro).toEqual(body['data_micro']);
  });

  it('never publishes usage, metrics or the chain of thought', () => {
    const result = JSON.stringify(
      parseWritingV3Response(
        withWritingErrorPriorityCapture(
          fixture('grade-v3-task1.response.json'),
          1,
        ),
      ),
    );

    expect(result).not.toContain('coT');
    expect(result).not.toContain('layer1_errors');
    expect(result).not.toContain('"usage"');
    expect(result).not.toContain('"metrics"');
    expect(result).not.toContain('input_tokens');
    expect(result).not.toContain('ai_processing_ms');
  });

  it('accepts a data_micro with codes AIHUB has never seen', () => {
    const body = withWritingErrorPriorityCapture(
      fixture('grade-v3-task2.response.json'),
      2,
    );
    const result = parseWritingV3Response({
      ...body,
      data_micro: {
        task_response: {
          ZZ99: { prompt: 'p', question_type: 'q', comments: [] },
        },
      },
    });

    expect(Value.Check(WritingV2GradeResponseSchema, result)).toBe(true);
  });

  it.each([
    ['a body that is not an object', 'text'],
    ['a missing data object', { success: true }],
    ['a missing overall band', { data: { evaluation: {} } }],
  ])('throws a contract violation for %s', (_label, body) => {
    expect(thrownBy(() => parseWritingV3Response(body))).toMatchObject({
      code: 'AI_SERVICE_CONTRACT_VIOLATION',
    });
  });

  it('throws a contract violation when a criterion has no numeric band', () => {
    const body = fixture('grade-v3-task2.response.json');
    const data = body['data'] as { evaluation: Record<string, unknown> };
    const broken = {
      ...body,
      data: {
        ...data,
        evaluation: {
          ...data.evaluation,
          '2_coherence_cohesion': { band_score: 'high' },
        },
      },
    };

    expect(thrownBy(() => parseWritingV3Response(broken))).toMatchObject({
      code: 'AI_SERVICE_CONTRACT_VIOLATION',
    });
  });
});
