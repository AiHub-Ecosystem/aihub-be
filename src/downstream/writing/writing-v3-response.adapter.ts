import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { CRITERION_IDS, type CriterionId } from '@/contracts/writing/grading';
import type { WritingV2GradeResponse } from '@/contracts/writing/v2/grading';
import { contractViolation } from '@/downstream/contract-violation';

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
 * Maps a captured-shape AI Writing v3 grading body onto the `/v2` response
 * (ADR-0143 decisions 1 to 3). Pure: no I/O, no clock, no logging. String values
 * pass through verbatim.
 */
export function parseWritingV3Response(body: unknown): WritingV2GradeResponse {
  if (!Value.Check(ProviderBody, body)) {
    const firstError = Value.Errors(ProviderBody, body).First();
    // The path names a field, never a value from the provider body.
    throw contractViolation(
      `response does not match the v3 shape at ${firstError?.path ?? '/'}`,
    );
  }
  const { data, data_micro } = body;
  const assessment = data['Overall Assessment'];

  return {
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
    data_micro,
  };
}
