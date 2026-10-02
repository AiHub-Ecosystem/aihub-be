import type { MeteringEvidence } from './metering-evidence';
import type {
  MeteringFinalizeInput,
  MeteringFinalizerPort,
  MeteringOutcome,
} from './metering-finalizer.port';

export interface MeteringCompletion {
  readonly requestId: string;
  readonly outcome: MeteringOutcome;
  readonly httpStatus: number;
  readonly errorCode?: string;
  readonly totalMs: number;
}

/**
 * The single place that can turn evidence into a Metering record.
 *
 * Both callers reach this and neither can bypass it, so two callers can no
 * longer compete for one request: the second call finds the evidence settled
 * and returns without writing (ADR-0061).
 *
 * A request that never authenticated carries no evidence, and so has no
 * Metering record. That is a business decision from the durable metering
 * boundary, not a side effect of validation, so it is stated here rather than
 * discovered by a shape check happening to fail.
 *
 * The record's required shape is already satisfied by the type that opened the
 * evidence, so nothing is checked here beyond the fact of arrival.
 */
export async function completeRequestMetering(
  evidence: MeteringEvidence | undefined,
  finalizer: MeteringFinalizerPort,
  completion: MeteringCompletion,
): Promise<void> {
  if (evidence === undefined || evidence.settled) {
    return;
  }

  evidence.settled = true;
  evidence.totalMs = completion.totalMs;
  await finalizer.finalize(record(evidence, completion)).catch(() => undefined);
}

function record(
  evidence: MeteringEvidence,
  completion: MeteringCompletion,
): MeteringFinalizeInput {
  return {
    requestId: completion.requestId,
    organizationId: evidence.organizationId,
    apiKeyId: evidence.apiKeyId,
    operation: evidence.operation,
    environment: evidence.environment,
    outcome: completion.outcome,
    httpStatus: completion.httpStatus,
    totalMs: completion.totalMs,
    ...(evidence.actorId === undefined ? {} : { actorId: evidence.actorId }),
    ...(completion.errorCode === undefined
      ? {}
      : { errorCode: completion.errorCode }),
    ...(evidence.usage === undefined ? {} : { usage: evidence.usage }),
    ...(evidence.models === undefined ? {} : { models: evidence.models }),
    ...(evidence.downstreamMs === undefined
      ? {}
      : { downstreamMs: evidence.downstreamMs }),
    ...(evidence.aiProcessingMs === undefined
      ? {}
      : { aiProcessingMs: evidence.aiProcessingMs }),
    ...(evidence.idempotentReplay === undefined
      ? {}
      : { idempotentReplay: evidence.idempotentReplay }),
    ...(evidence.modelCalled === undefined
      ? {}
      : { modelCalled: evidence.modelCalled }),
    ...(evidence.quotaTracked === undefined
      ? {}
      : { quotaTracked: evidence.quotaTracked }),
    ...(evidence.quotaUnverified === undefined
      ? {}
      : { quotaUnverified: evidence.quotaUnverified }),
  };
}
