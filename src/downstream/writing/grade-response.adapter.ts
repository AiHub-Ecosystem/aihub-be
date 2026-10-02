import { AppError } from '@/common/errors/app-error';
import {
  CRITERION_IDS,
  type CriterionId,
  type GradeResponse,
} from '@/contracts/writing/grading';

const CRITERION_NAMES: Readonly<Record<CriterionId, string>> = {
  task_achievement: 'Task Achievement',
  task_response: 'Task Response',
  coherence_cohesion: 'Coherence and Cohesion',
  lexical_resource: 'Lexical Resource',
  grammatical_range_accuracy: 'Grammatical Range and Accuracy',
};

const CRITERION_ID_SET: ReadonlySet<string> = new Set(CRITERION_IDS);

function isCriterionId(value: string): value is CriterionId {
  return CRITERION_ID_SET.has(value);
}

/** Downstream signals "nothing to add" with this sentinel instead of `[]`. */
const EMPTY_SENTINEL = 'none specified';

function contractViolation(reason: string): AppError {
  return new AppError({
    code: 'AI_SERVICE_CONTRACT_VIOLATION',
    // Deliberately generic: the reason travels in `cause` for logs, never to
    // the client.
    message: 'AI service returned an unexpected response shape',
    retryable: false,
    cause: new Error(reason),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.toLowerCase() !== EMPTY_SENTINEL);
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * `data_micro` is `{ criterion: { issue: { comments: [{quote, explanation}] } } }`.
 * The issue keys vary per run, so flatten instead of enumerating them.
 */
function toAnnotations(value: unknown): GradeResponse['annotations'] {
  if (!isRecord(value)) {
    return [];
  }

  const annotations: GradeResponse['annotations'] = [];

  for (const [criterion, issues] of Object.entries(value)) {
    if (!isCriterionId(criterion) || !isRecord(issues)) {
      continue;
    }

    for (const [issue, body] of Object.entries(issues)) {
      if (!isRecord(body) || !Array.isArray(body.comments)) {
        continue;
      }

      for (const comment of body.comments) {
        if (!isRecord(comment)) {
          continue;
        }

        const quote = toText(comment.quote);
        const explanation = toText(comment.explanation);

        if (quote.length > 0) {
          annotations.push({ criterion, issue, quote, explanation });
        }
      }
    }
  }

  return annotations;
}

function toCriteria(value: unknown): GradeResponse['criteria'] {
  if (!isRecord(value)) {
    throw contractViolation('data.evaluation is not an object');
  }

  // Downstream keys are `1_task_achievement`, `2_coherence_cohesion`, ... so a
  // plain sort reproduces the intended order.
  return Object.keys(value)
    .sort()
    .map((key) => {
      const id = key.replace(/^\d+_/, '');
      const entry = value[key];

      if (!isCriterionId(id)) {
        throw contractViolation(`unknown criterion key: ${key}`);
      }

      if (!isRecord(entry) || typeof entry.band_score !== 'number') {
        throw contractViolation(`criterion ${key} has no numeric band_score`);
      }

      return {
        id,
        name: CRITERION_NAMES[id],
        band: entry.band_score,
        band_reason: toText(entry.band_reason),
        strengths: toStringList(entry.strengths),
        improvements: toStringList(entry.areas_for_improvement),
      };
    });
}

/**
 * Maps a raw AI Writing grading body onto the canonical response.
 *
 * Pure: no I/O, no clock, no logging. Both grading operations share it because
 * the payloads differ only in the first criterion key.
 *
 * Deliberately dropped, and they must never reach a client:
 * - `data.coT` — internal chain-of-thought (prompt engineering).
 * - `evaluation.*.feedback_detail` — a stringified copy of `data_micro`.
 * - `data_micro.*.*.question_type` — means the chart type on Task 1 and the
 *   subject on Task 2, so it is not usable as one field.
 */
export function parseGradeResponse(body: unknown): GradeResponse {
  if (!isRecord(body)) {
    throw contractViolation('response body is not an object');
  }

  const data = body.data;

  if (!isRecord(data)) {
    throw contractViolation('missing data');
  }

  if (typeof data.overall_band !== 'number') {
    throw contractViolation('missing numeric data.overall_band');
  }

  const criteria = toCriteria(data.evaluation);

  if (criteria.length !== 4) {
    throw contractViolation(`expected 4 criteria, received ${criteria.length}`);
  }

  const assessment = data['Overall Assessment'];
  const overall = isRecord(assessment) ? assessment : {};

  return {
    overall_band: data.overall_band,
    language: 'vi',
    criteria,
    summary: toText(overall.Summary),
    suggestions: toStringList(overall['Specific Suggestions']),
    next_steps: toStringList(overall['Next Steps']),
    annotations: toAnnotations(body.data_micro),
  };
}
