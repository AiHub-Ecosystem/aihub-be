import { Value } from '@sinclair/typebox/value';

import { AppError } from '../../common/errors/app-error';
import {
  type SpeakingGradeResponse,
  SpeakingGradeResponseSchema,
} from '../../contracts/speaking/grading';

function contractViolation(reason: string): AppError {
  return new AppError({
    code: 'AI_SERVICE_CONTRACT_VIOLATION',
    message: 'AI service returned an unexpected response shape',
    retryable: false,
    cause: new Error(reason),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw contractViolation(`missing string field ${field}`);
  }
  return value;
}

function optionalNullableString(
  data: Record<string, unknown>,
  field: string,
): string | null | undefined {
  if (!(field in data)) {
    return undefined;
  }

  const value = data[field];
  if (value !== null && typeof value !== 'string') {
    throw contractViolation(`field ${field} is not a string or null`);
  }
  return value;
}

function requiredGroup(data: Record<string, unknown>, field: string): unknown {
  const value = data[field];
  if (!isRecord(value)) {
    throw contractViolation(`missing object group ${field}`);
  }
  return value;
}

function requiredNullableGroup(
  data: Record<string, unknown>,
  field: string,
): Record<string, unknown> | null {
  const value = data[field];
  if (value !== null && !isRecord(value)) {
    throw contractViolation(`missing object or null group ${field}`);
  }
  return value;
}

function requiredCollection(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  throw contractViolation(`field ${field} is not a collection`);
}

function normalizePronunciationDetail(value: unknown): unknown {
  if (!isRecord(value)) {
    throw contractViolation('missing object group pronunciation_detail');
  }

  const words = requiredCollection(
    value.words,
    'pronunciation_detail.words',
  ).map((word, index) => {
    if (!isRecord(word)) {
      throw contractViolation(`pronunciation word ${index} is not an object`);
    }
    return {
      ...word,
      syllables: requiredCollection(
        word.syllables,
        `pronunciation_detail.words[${index}].syllables`,
      ),
      phonemes: requiredCollection(
        word.phonemes,
        `pronunciation_detail.words[${index}].phonemes`,
      ),
    };
  });

  return { ...value, words };
}

function normalizeLanguageAnalysis(value: unknown): unknown {
  if (!isRecord(value)) {
    throw contractViolation('missing object group language_analysis');
  }

  return {
    ...value,
    grammar_errors: requiredCollection(
      value.grammar_errors,
      'language_analysis.grammar_errors',
    ),
    vocabulary_upgrades: requiredCollection(
      value.vocabulary_upgrades,
      'language_analysis.vocabulary_upgrades',
    ),
  };
}

/**
 * Maps only the documented Speaking result groups. The field-level schemas
 * reject unconfirmed nested provider fields, and unknown top-level fields are
 * deliberately dropped so the provider response cannot become the public
 * contract by accident. Provider session/test/user identifiers stay private
 * until the D2 TSD confirms their public meaning.
 */
export function parseSpeakingGradeResponse(
  body: unknown,
): SpeakingGradeResponse {
  if (!isRecord(body) || body.status !== 'success' || !isRecord(body.data)) {
    throw contractViolation('missing successful provider data');
  }

  const data = body.data;
  const testType = optionalNullableString(data, 'test_type');
  const normalized = {
    ...(testType === undefined ? {} : { test_type: testType }),
    question_id: requiredString(data, 'question_id'),
    scorability: requiredGroup(data, 'scorability'),
    estimated_band: requiredGroup(data, 'estimated_band'),
    transcript: requiredGroup(data, 'transcript'),
    relevance: requiredGroup(data, 'relevance'),
    fluency_metrics: requiredNullableGroup(data, 'fluency_metrics'),
    pronunciation_detail: normalizePronunciationDetail(
      data.pronunciation_detail,
    ),
    language_analysis: normalizeLanguageAnalysis(data.language_analysis),
    feedback: requiredGroup(data, 'feedback'),
  };

  if (!Value.Check(SpeakingGradeResponseSchema, normalized)) {
    throw contractViolation('normalized Speaking response failed validation');
  }

  return Value.Parse(SpeakingGradeResponseSchema, normalized);
}
