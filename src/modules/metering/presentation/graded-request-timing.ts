import type { OperationId } from '@/catalog/operation-id';
import { registry } from '@/common/observability/metrics';
import {
  type GradedRequestTiming,
  getMeteringEvidence,
} from '@/modules/metering/application/metering-evidence';
import { Histogram } from '@prometheus-io/client';

const admissionDuration = new Histogram({
  name: 'aihub_admission_duration_seconds',
  help: 'Time from request receipt to gateway dispatch admission, in seconds.',
  labelNames: ['operation', 'identity_mode', 'retry_budget'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

const completionDuration = new Histogram({
  name: 'aihub_graded_completion_duration_seconds',
  help: 'Time from AI Service result availability through metering and concurrency permit release.',
  labelNames: ['operation', 'identity_mode', 'retry_budget'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export function setGradedRequestDimensions(
  request: unknown,
  dimensions: {
    readonly operation: OperationId;
    readonly identityMode: GradedRequestTiming['identityMode'];
    readonly retryBudget: GradedRequestTiming['retryBudget'];
  },
): void {
  const evidence = getMeteringEvidence(request);
  if (evidence === undefined) return;
  evidence.gradedRequestTiming = {
    identityMode: dimensions.identityMode,
    retryBudget: dimensions.retryBudget,
  };
}

export function recordGradedAdmission(
  operation: OperationId,
  admissionMs: number | undefined,
  dimensions:
    | {
        readonly identityMode: GradedRequestTiming['identityMode'];
        readonly retryBudget: GradedRequestTiming['retryBudget'];
      }
    | undefined,
): void {
  if (
    admissionMs === undefined ||
    !Number.isFinite(admissionMs) ||
    admissionMs < 0
  ) {
    return;
  }
  admissionDuration.observe(
    {
      operation,
      identity_mode: dimensions?.identityMode ?? 'unknown',
      retry_budget: dimensions?.retryBudget ?? 'none',
    },
    admissionMs / 1000,
  );
}

export function markGradedCompletionStarted(request: unknown): void {
  const timing = getMeteringEvidence(request)?.gradedRequestTiming;
  if (timing !== undefined && timing.completionStartedAt === undefined) {
    timing.completionStartedAt = performance.now();
  }
}

export function markGradedCompletionSettled(request: unknown): void {
  const evidence = getMeteringEvidence(request);
  const timing = evidence?.gradedRequestTiming;
  if (
    evidence === undefined ||
    timing === undefined ||
    timing.completionStartedAt === undefined ||
    timing.completionMs !== undefined
  ) {
    return;
  }
  timing.completionMs = Math.max(
    0,
    Math.round(performance.now() - timing.completionStartedAt),
  );
  completionDuration.observe(
    {
      operation: evidence.operation,
      identity_mode: timing.identityMode,
      retry_budget: timing.retryBudget,
    },
    timing.completionMs / 1000,
  );
}

export function requestGradedDimensions(request: unknown):
  | {
      readonly identityMode: GradedRequestTiming['identityMode'];
      readonly retryBudget: GradedRequestTiming['retryBudget'];
    }
  | undefined {
  const timing = getMeteringEvidence(request)?.gradedRequestTiming;
  if (timing === undefined) return undefined;
  return {
    identityMode: timing.identityMode,
    retryBudget: timing.retryBudget,
  };
}

export function requestGradedCompletionMs(
  request: unknown,
): number | undefined {
  return getMeteringEvidence(request)?.gradedRequestTiming?.completionMs;
}
