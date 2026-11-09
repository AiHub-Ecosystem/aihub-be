import { isRecord } from '@/common/is-record';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { contractViolation } from '@/downstream/contract-violation';

import { fromProviderSpeakingTestType } from '@/contracts/speaking/v2/test-type';

const CRITERIA = [
  'fluency_coherence',
  'lexical_resource',
  'grammatical_range_accuracy',
  'pronunciation',
] as const;

function diagnosticProjection(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value['reference'])) {
    throw contractViolation('invalid Speaking v2 diagnostic');
  }
  const { reference } = value;
  return {
    reference: {
      token_range: reference['token_range'],
      text: reference['text'],
      start_ms: reference['start_ms'],
      end_ms: reference['end_ms'],
    },
    kind: value['kind'],
    error_codes: value['error_codes'],
    explain_vi: value['explain_vi'],
    improvement: value['improvement'],
    improvement_vi: value['improvement_vi'],
  };
}

function criteriaProjection(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw contractViolation('missing Speaking v2 criteria');
  }
  return Object.fromEntries(
    CRITERIA.map((name) => {
      const criterion = value[name];
      if (!isRecord(criterion) || !isRecord(criterion['summary'])) {
        throw contractViolation('missing Speaking v2 criterion');
      }
      const { summary, diagnostics } = criterion;
      return [
        name,
        {
          summary: {
            reason_for_band_vi: summary['reason_for_band_vi'],
            strengths_vi: summary['strengths_vi'],
            areas_for_improvement_vi: summary['areas_for_improvement_vi'],
          },
          // Anything but null or a list is left undefined for the schema to refuse.
          diagnostics:
            diagnostics === null
              ? null
              : Array.isArray(diagnostics)
                ? diagnostics.map(diagnosticProjection)
                : undefined,
        },
      ];
    }),
  );
}

function transcriptProjection(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    !isRecord(value['stats']) ||
    !Array.isArray(value['tokens'])
  ) {
    throw contractViolation('missing Speaking v2 transcript');
  }
  return {
    text: value['text'],
    stats: {
      word_count: value['stats']['word_count'],
      speaking_seconds: value['stats']['speaking_seconds'],
    },
    tokens: value['tokens'].map((token: unknown) => {
      if (!isRecord(token)) {
        throw contractViolation('invalid Speaking v2 transcript token');
      }
      return {
        index: token['index'],
        text: token['text'],
        start_ms: token['start_ms'],
        end_ms: token['end_ms'],
      };
    }),
  };
}

export function speakingV2Projection(body: unknown): Record<string, unknown> {
  if (
    !isRecord(body) ||
    body['status'] !== 'success' ||
    !isRecord(body['data'])
  ) {
    throw contractViolation('missing successful provider data');
  }
  const source = body['data'];
  const meta = source['meta'];
  if (
    !isRecord(meta) ||
    !isRecord(source['scores']) ||
    !isRecord(source['overall_feedback'])
  ) {
    throw contractViolation('missing required Speaking v2 result group');
  }
  const { schema_version, result_type, test_id, test_type, graded_at } = meta;
  const publicTestType = fromProviderSpeakingTestType(test_type);
  if (publicTestType === undefined) {
    throw contractViolation('invalid provider test_type');
  }
  const commonMeta = {
    schema_version,
    result_type,
    test_id,
    test_type: publicTestType,
    graded_at,
  };
  const feedback = source['overall_feedback'];
  const data: Record<string, unknown> = {
    scores: source['scores'],
    overall_feedback: {
      overview_vi: feedback['overview_vi'],
      details: feedback['details'],
    },
    criteria: criteriaProjection(source['criteria']),
  };
  if (result_type === 'question_result') {
    data['transcript'] = transcriptProjection(source['transcript']);
    data['meta'] = {
      ...commonMeta,
      part: meta['part'],
      question_id: meta['question_id'],
      response_id: meta['response_id'],
      part_result_id: meta['part_result_id'],
    };
  } else if (result_type === 'part_result') {
    data['meta'] = {
      ...commonMeta,
      part_result_id: meta['part_result_id'],
      part: meta['part'],
      question_count: meta['question_count'],
      total_speaking_seconds: meta['total_speaking_seconds'],
    };
  } else if (result_type === 'test_result') {
    data['meta'] = {
      ...commonMeta,
      question_count: meta['question_count'],
      total_speaking_seconds: meta['total_speaking_seconds'],
      parts_completed: meta['parts_completed'],
    };
  } else {
    throw contractViolation('unknown Speaking v2 result type');
  }
  return data;
}

export function validateSpeakingV2Result(
  schema: TSchema,
  value: unknown,
): void {
  if (!Value.Check(schema, value)) {
    throw contractViolation(
      'normalized Speaking v2 response failed validation',
    );
  }
}
