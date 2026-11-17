import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { MODEL_TEXT_MAX_LENGTH } from '@/contracts/model-text';
import { CRITERION_IDS, type CriterionId } from '@/contracts/writing/grading';
import {
  WritingErrorPrioritySchema,
  type WritingV2GradeResponse,
  WritingV2GradeResponseSchema,
} from '@/contracts/writing/v2/grading';
import { contractViolation } from '@/downstream/contract-violation';
import { stripControlCharacters } from '@/downstream/model-text';
import { assertPublicContract } from '@/downstream/public-contract';

const Strings = Type.Array(Type.String());

const ProviderCriterion = Type.Object({
  band_score: Type.Number(),
  band_reason: Type.String(),
  strengths: Strings,
  areas_for_improvement: Strings,
  errors: Type.Array(
    Type.Object({
      quote: Type.String(),
      error_codes: Type.String(),
      error_name: Type.String(),
      explanation: Type.String(),
      improved_version: Type.String(),
    }),
  ),
  suggestions: Type.Array(
    Type.Object({
      quote: Type.String(),
      explanation: Type.String(),
      improved_version: Type.String(),
    }),
  ),
  feedback_detail: Strings,
});

const ProviderErrorPriority = Type.Omit(WritingErrorPrioritySchema, [], {
  additionalProperties: true,
});

// Shape read from the captured v3 fixtures (test/fixtures/ai-writing/
// grade-v3-task{1,2}.*) and the provider document, nothing more. Fields the
// customer never sees (`usage`, `metrics`, `coT`, `data.task`) are not read.
const ProviderBody = Type.Object({
  data_micro: Type.Record(
    Type.String(),
    Type.Record(
      Type.String(),
      Type.Object({
        prompt: Type.String(),
        question_type: Type.String(),
        comments: Type.Array(
          Type.Object({ quote: Type.String(), explanation: Type.String() }),
        ),
      }),
    ),
  ),
  data: Type.Object({
    overall_band: Type.Number(),
    evaluation: Type.Record(Type.String(), ProviderCriterion),
    'Overall Assessment': Type.Object({
      Summary: Type.Object({
        Overall: Type.String(),
        Detail: Strings,
        CTA: Type.String(),
      }),
      Progress: Type.Object({
        status: Type.String(),
        error_recur: Strings,
        error_impro: Strings,
        error_new: Strings,
      }),
    }),
    error_priority: Type.Array(ProviderErrorPriority, { maxItems: 3 }),
  }),
});

type ProviderBodyShape = Static<typeof ProviderBody>;

const CRITERION_ID_SET: ReadonlySet<string> = new Set(CRITERION_IDS);

function isCriterionId(value: string): value is CriterionId {
  return CRITERION_ID_SET.has(value);
}

function toCriteria(
  evaluation: ProviderBodyShape['data']['evaluation'],
): WritingV2GradeResponse['criteria'] {
  // Provider keys are `1_task_achievement`, `2_coherence_cohesion`, ...: a plain
  // sort reproduces the intended order.
  const criteria = Object.keys(evaluation)
    .sort()
    .map((key) => {
      const id = key.replace(/^\d+_/, '');
      const entry = evaluation[key];
      if (!isCriterionId(id) || entry === undefined) {
        throw contractViolation('unknown criterion key');
      }
      return {
        id,
        band: entry.band_score,
        band_reason: entry.band_reason,
        strengths: entry.strengths,
        areas_for_improvement: entry.areas_for_improvement,
        errors: entry.errors,
        suggestions: entry.suggestions,
        feedback_detail: entry.feedback_detail,
      };
    });
  if (criteria.length !== 4) {
    throw contractViolation(`expected 4 criteria, received ${criteria.length}`);
  }
  return criteria;
}

/**
 * `data_micro` is keyed by provider text: a trait, then an error code. A schema
 * cannot bound a record key, so the length is checked here, with the same limit
 * as every other model-generated label.
 */
function assertKeysWithinTextLimit(
  dataMicro: ProviderBodyShape['data_micro'],
): void {
  for (const [trait, errors] of Object.entries(dataMicro)) {
    if (
      trait.length > MODEL_TEXT_MAX_LENGTH ||
      Object.keys(errors).some((code) => code.length > MODEL_TEXT_MAX_LENGTH)
    ) {
      throw contractViolation('data_micro key exceeds the text limit');
    }
  }
}

/**
 * Maps a captured-shape AI Writing v3 grading body onto the `/v2` response
 * (ADR-0143 decisions 1 to 3). Pure: no I/O, no clock, no logging. String values
 * pass through verbatim.
 */
export function parseWritingV3Response(
  rawBody: unknown,
): WritingV2GradeResponse {
  const body = stripControlCharacters(rawBody);
  if (!Value.Check(ProviderBody, body)) {
    const firstError = Value.Errors(ProviderBody, body).First();
    // The path names a field, never a value from the provider body.
    throw contractViolation(
      `response does not match the v3 shape at ${firstError?.path ?? '/'}`,
    );
  }
  const { data, data_micro } = body;
  assertKeysWithinTextLimit(data_micro);
  const assessment = data['Overall Assessment'];

  const response: WritingV2GradeResponse = {
    overall_band: data.overall_band,
    criteria: toCriteria(data.evaluation),
    overall_assessment: {
      summary: {
        overall: assessment.Summary.Overall,
        detail: assessment.Summary.Detail,
        cta: assessment.Summary.CTA,
      },
      progress: {
        status: assessment.Progress.status,
        error_recur: assessment.Progress.error_recur,
        error_impro: assessment.Progress.error_impro,
        error_new: assessment.Progress.error_new,
      },
    },
    error_priority: data.error_priority.map(
      ({ rank, group, code, name_en, name_vi, reason_vi }) => ({
        rank,
        group,
        code,
        name_en,
        name_vi,
        reason_vi,
      }),
    ),
    data_micro,
  };
  assertPublicContract(WritingV2GradeResponseSchema, response);
  return response;
}
