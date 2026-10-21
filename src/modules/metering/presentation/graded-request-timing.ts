import type { OperationId } from '@/catalog/operation-id';
import { registry } from '@/common/observability/metrics';
import { Histogram } from '@prometheus-io/client';

type IdentityMode = 'declared_id' | 'signed_assertion' | 'unknown';
type RetryBudget = 'keyed_writing' | 'none';

interface GradedRequestTiming {
  readonly operation: OperationId;
  readonly identityMode: IdentityMode;
  readonly retryBudget: RetryBudget;
  completionStartedAt?: number;
  completionMs?: number;
}

const timingByRequest = new WeakMap<object, GradedRequestTiming>();

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

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

export function setGradedRequestDimensions(
  rawRequest: unknown,
  dimensions: {
    readonly operation: OperationId;
    readonly identityMode: IdentityMode;
    readonly retryBudget: RetryBudget;
  },
): void {
  if (!isObject(rawRequest)) return;
  timingByRequest.set(rawRequest, { ...dimensions });
}

export function recordGradedAdmission(
  operation: OperationId,
  admissionMs: number | undefined,
  dimensions:
    | {
        readonly identityMode: IdentityMode;
        readonly retryBudget: RetryBudget;
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

export function markGradedCompletionStarted(rawRequest: unknown): void {
  const timing = isObject(rawRequest)
    ? timingByRequest.get(rawRequest)
    : undefined;
  if (timing !== undefined && timing.completionStartedAt === undefined) {
    timing.completionStartedAt = performance.now();
  }
}

export function markGradedCompletionSettled(rawRequest: unknown): void {
  const timing = isObject(rawRequest)
    ? timingByRequest.get(rawRequest)
    : undefined;
  if (
    timing?.completionStartedAt === undefined ||
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
      operation: timing.operation,
      identity_mode: timing.identityMode,
      retry_budget: timing.retryBudget,
    },
    timing.completionMs / 1000,
  );
}

export function requestGradedDimensions(rawRequest: unknown):
  | {
      readonly identityMode: IdentityMode;
      readonly retryBudget: RetryBudget;
    }
  | undefined {
  const timing = isObject(rawRequest)
    ? timingByRequest.get(rawRequest)
    : undefined;
  if (timing === undefined) return undefined;
  return {
    identityMode: timing.identityMode,
    retryBudget: timing.retryBudget,
  };
}

export function requestGradedCompletionMs(
  rawRequest: unknown,
): number | undefined {
  const timing = isObject(rawRequest)
    ? timingByRequest.get(rawRequest)
    : undefined;
  return timing?.completionMs;
}
