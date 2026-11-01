import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppError } from '@/common/errors/app-error';

import { parseSpeakingV2PartResult } from './speaking-v2-part-response.adapter';
import { parseSpeakingV2QuestionResult } from './speaking-v2-question-response.adapter';
import { parseSpeakingV2TestResult } from './speaking-v2-test-response.adapter';

const FIXTURES = join(__dirname, '../../../test/fixtures/ai-speaking');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

function forbiddenPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      forbiddenPaths(item, `${path}[${index}]`),
    );
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) => {
    const current = `${path}.${key}`;
    const hidden =
      /^(user_id|system|href|cost|codebook|glossary|asr|asr_agreement|evidence|recurring_patterns|test_level_errors)$/.test(
        key,
      )
        ? [current]
        : [];
    return [...hidden, ...forbiddenPaths(item, current)];
  });
}

describe('Speaking v2 response adapters', () => {
  it.each([
    ['grading-v2-question-post.200.json', parseSpeakingV2QuestionResult],
    ['grading-v2-question-post-second.200.json', parseSpeakingV2QuestionResult],
    ['grading-v2-question-get.200.json', parseSpeakingV2QuestionResult],
    ['grading-v2-part-post.200.json', parseSpeakingV2PartResult],
    ['grading-v2-part-get.200.json', parseSpeakingV2PartResult],
    ['grading-v2-test-post.200.json', parseSpeakingV2TestResult],
    ['grading-v2-test-get.200.json', parseSpeakingV2TestResult],
  ])('projects captured result %s without private fields', (name, parse) => {
    expect(forbiddenPaths(parse(fixture(name)))).toEqual([]);
  });

  it('exposes the transcript and located findings of a question result', () => {
    const result = parseSpeakingV2QuestionResult(
      fixture('grading-v2-question-post.200.json'),
    );

    expect(result.transcript.text.length).toBeGreaterThan(0);
    expect(Object.keys(result.transcript.tokens[0] ?? {}).sort()).toEqual([
      'end_ms',
      'index',
      'start_ms',
      'text',
    ]);
    const findings = result.criteria.grammatical_range_accuracy.diagnostics;
    expect(findings?.length).toBeGreaterThan(0);
    expect(Object.keys(findings?.[0] ?? {}).sort()).toEqual([
      'error_codes',
      'explain_vi',
      'improvement',
      'improvement_vi',
      'kind',
      'reference',
    ]);
  });

  it.each([
    ['grading-v2-part-post.200.json', parseSpeakingV2PartResult],
    ['grading-v2-test-post.200.json', parseSpeakingV2TestResult],
  ])(
    'gives aggregate result %s criteria without a transcript',
    (name, parse) => {
      const result = parse(fixture(name));

      expect(result).not.toHaveProperty('transcript');
      expect(result.criteria.pronunciation.summary.reason_for_band_vi).toEqual(
        expect.any(String),
      );
      expect(result.criteria.pronunciation.diagnostics).toBeNull();
    },
  );

  it('fails closed when criteria or the transcript is missing', () => {
    const noCriteria = fixture('grading-v2-question-post.200.json') as {
      data: Record<string, unknown>;
    };
    delete noCriteria.data.criteria;
    expect(() => parseSpeakingV2QuestionResult(noCriteria)).toThrow(AppError);

    const noTranscript = fixture('grading-v2-question-post.200.json') as {
      data: Record<string, unknown>;
    };
    noTranscript.data.transcript = null;
    expect(() => parseSpeakingV2QuestionResult(noTranscript)).toThrow(AppError);
  });

  it('fails closed when a required score is missing or mistyped', () => {
    const missing = fixture('grading-v2-question-post.200.json') as {
      data: { scores: Record<string, unknown> };
    };
    delete missing.data.scores.overall;
    expect(() => parseSpeakingV2QuestionResult(missing)).toThrow(AppError);

    const mistyped = fixture('grading-v2-question-post.200.json') as {
      data: { scores: Record<string, unknown> };
    };
    mistyped.data.scores.overall = '7.5';
    expect(() => parseSpeakingV2QuestionResult(mistyped)).toThrow(AppError);
  });
});
