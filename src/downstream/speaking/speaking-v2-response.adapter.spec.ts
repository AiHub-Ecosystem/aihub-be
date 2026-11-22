import { AppError } from '@/common/errors/app-error';
import { isRecord } from '@/common/is-record';

import { fixtureJson } from '../../../test/support/json-fixtures';
import { parseSpeakingV2PartResult } from './speaking-v2-part-response.adapter';
import { parseSpeakingV2QuestionResult } from './speaking-v2-question-response.adapter';
import { parseSpeakingV2TestResult } from './speaking-v2-test-response.adapter';

function forbiddenPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      forbiddenPaths(item, `${path}[${index}]`),
    );
  }
  if (!isRecord(value)) return [];
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
  function withErrorPriority(body: unknown, priorities: unknown): unknown {
    if (!isRecord(body) || !isRecord(body['data'])) {
      throw new Error('provider fixture has no data object');
    }

    body['data']['error_priority'] = priorities;
    return body;
  }

  function prioritySample(resultType: string): unknown[] {
    const sample = fixtureJson(
      'ai-speaking',
      'grading-v2-error-priority.provider-sample.json',
    );
    if (!isRecord(sample)) {
      throw new Error('provider priority sample is not an object');
    }
    const entries = sample[resultType];
    if (!Array.isArray(entries)) {
      throw new Error(`provider priority sample has no ${resultType}`);
    }
    return entries;
  }

  function withPrioritySample(body: unknown, resultType: string): unknown {
    return withErrorPriority(body, prioritySample(resultType));
  }

  function withEmptyPriority(body: unknown): unknown {
    return withErrorPriority(body, []);
  }

  it.each([
    [
      'grading-v2-question-post.200.json',
      'question_result',
      parseSpeakingV2QuestionResult,
    ],
    [
      'grading-v2-question-post-second.200.json',
      'question_result',
      parseSpeakingV2QuestionResult,
    ],
    [
      'grading-v2-question-get.200.json',
      'question_result',
      parseSpeakingV2QuestionResult,
    ],
    ['grading-v2-part-post.200.json', 'part_result', parseSpeakingV2PartResult],
    ['grading-v2-part-get.200.json', 'part_result', parseSpeakingV2PartResult],
    ['grading-v2-test-post.200.json', 'test_result', parseSpeakingV2TestResult],
    ['grading-v2-test-get.200.json', 'test_result', parseSpeakingV2TestResult],
  ])(
    'projects provider priority for captured result %s',
    (name, resultType, parse) => {
      const body = withPrioritySample(
        fixtureJson('ai-speaking', name),
        resultType,
      );
      const result = parse(body);

      expect(forbiddenPaths(result)).toEqual([]);
      expect(result.error_priority).toEqual(prioritySample(resultType));
    },
  );

  it('accepts the captured empty list returned for a no-speech question', () => {
    const body = withPrioritySample(
      fixtureJson('ai-speaking', 'grading-v2-question-post.200.json'),
      'live_no_speech_question_result',
    );

    expect(parseSpeakingV2QuestionResult(body).error_priority).toEqual([]);
  });

  it('rejects a provider result that omits error_priority', () => {
    const body = fixtureJson(
      'ai-speaking',
      'grading-v2-question-post.200.json',
    );

    expect(() => parseSpeakingV2QuestionResult(body)).toThrow(AppError);
  });

  it('preserves provider priority order and accepts configured group and code strings', () => {
    const priorities = prioritySample('question_result');
    const first = priorities[0];
    if (!isRecord(first)) throw new Error('priority sample has no first entry');
    priorities[0] = {
      ...first,
      group: 'provider_future_group',
      code: 'NEW01',
      provider_trace: 'ignored',
    };
    const body = withErrorPriority(
      fixtureJson('ai-speaking', 'grading-v2-question-post.200.json'),
      priorities,
    );

    const result = parseSpeakingV2QuestionResult(body);

    expect(result.error_priority[0]).toMatchObject({
      rank: 1,
      group: 'provider_future_group',
      code: 'NEW01',
    });
    expect(result.error_priority[0]).not.toHaveProperty('provider_trace');
  });

  it('exposes the transcript and located findings of a question result', () => {
    const result = parseSpeakingV2QuestionResult(
      withEmptyPriority(
        fixtureJson('ai-speaking', 'grading-v2-question-post.200.json'),
      ),
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
      const result = parse(withEmptyPriority(fixtureJson('ai-speaking', name)));

      expect(result).not.toHaveProperty('transcript');
      expect(result.criteria.pronunciation.summary.reason_for_band_vi).toEqual(
        expect.any(String),
      );
      expect(result.criteria.pronunciation.diagnostics).toBeNull();
    },
  );

  it('fails closed when criteria or the transcript is missing', () => {
    const noCriteria = fixtureJson(
      'ai-speaking',
      'grading-v2-question-post.200.json',
    ) as {
      data: Record<string, unknown>;
    };
    noCriteria.data['error_priority'] = [];
    delete noCriteria.data['criteria'];
    expect(() => parseSpeakingV2QuestionResult(noCriteria)).toThrow(AppError);

    const noTranscript = fixtureJson(
      'ai-speaking',
      'grading-v2-question-post.200.json',
    ) as {
      data: Record<string, unknown>;
    };
    noTranscript.data['error_priority'] = [];
    noTranscript.data['transcript'] = null;
    expect(() => parseSpeakingV2QuestionResult(noTranscript)).toThrow(AppError);
  });

  it('accepts the nulls the provider returns for ids the caller did not send and for audio with no speech', () => {
    // A real call with no test_id, no part_result_id and a recording without
    // speech returned null for all three; the captured fixtures supplied them.
    const body = fixtureJson(
      'ai-speaking',
      'grading-v2-question-post.200.json',
    ) as {
      data: Record<string, unknown> & {
        meta: Record<string, unknown>;
        transcript: { stats: Record<string, unknown> };
      };
    };
    body.data['error_priority'] = [];
    body.data.meta['test_id'] = null;
    body.data.meta['part_result_id'] = null;
    body.data.transcript.stats['speaking_seconds'] = null;
    body.data.transcript.stats['word_count'] = null;

    const result = parseSpeakingV2QuestionResult(body);

    expect(result.meta.test_id).toBeNull();
    expect(result.meta.part_result_id).toBeNull();
    expect(result.transcript.stats.speaking_seconds).toBeNull();
  });

  it.each([
    ['grading-v2-part-post.200.json', parseSpeakingV2PartResult],
    ['grading-v2-test-post.200.json', parseSpeakingV2TestResult],
  ])(
    'accepts a null total_speaking_seconds on %s, which the provider returns for recordings without speech',
    (name, parse) => {
      const body = fixtureJson('ai-speaking', name) as {
        data: Record<string, unknown> & { meta: Record<string, unknown> };
      };
      body.data['error_priority'] = [];
      body.data.meta['total_speaking_seconds'] = null;

      expect(parse(body).meta.total_speaking_seconds).toBeNull();
    },
  );

  it('accepts a located finding whose codes and advice are null, which a real recording returned', () => {
    const body = fixtureJson(
      'ai-speaking',
      'grading-v2-question-post.200.json',
    ) as {
      data: Record<string, unknown> & {
        criteria: Record<string, { diagnostics: Record<string, unknown>[] }>;
      };
    };
    body.data['error_priority'] = [];
    const finding =
      body.data.criteria['grammatical_range_accuracy']?.diagnostics[0];
    if (finding === undefined) throw new Error('fixture has no finding');
    finding['error_codes'] = null;
    finding['explain_vi'] = null;
    finding['improvement'] = null;
    finding['improvement_vi'] = null;

    const result = parseSpeakingV2QuestionResult(body);

    expect(
      result.criteria.grammatical_range_accuracy.diagnostics?.[0]?.error_codes,
    ).toBeNull();
  });

  it('fails closed when a required score is missing or mistyped', () => {
    const missing = fixtureJson(
      'ai-speaking',
      'grading-v2-question-post.200.json',
    ) as {
      data: Record<string, unknown> & { scores: Record<string, unknown> };
    };
    missing.data['error_priority'] = [];
    delete missing.data.scores['overall'];
    expect(() => parseSpeakingV2QuestionResult(missing)).toThrow(AppError);

    const mistyped = fixtureJson(
      'ai-speaking',
      'grading-v2-question-post.200.json',
    ) as {
      data: Record<string, unknown> & { scores: Record<string, unknown> };
    };
    mistyped.data['error_priority'] = [];
    mistyped.data.scores['overall'] = '7.5';
    expect(() => parseSpeakingV2QuestionResult(mistyped)).toThrow(AppError);
  });
});
