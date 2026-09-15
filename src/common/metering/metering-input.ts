import type { MeteringFinalizeInput } from './metering-finalizer.port';
import type { RequestMeteringState } from './metering.types';

export function createMeteringFinalizeInput(
  state: RequestMeteringState,
  input: Pick<MeteringFinalizeInput, 'outcome' | 'httpStatus' | 'totalMs'> &
    Partial<Pick<MeteringFinalizeInput, 'errorCode' | 'meteringStatus'>>,
): MeteringFinalizeInput | undefined {
  if (
    state.requestId.length === 0 ||
    state.operation === undefined ||
    state.organizationId === undefined ||
    state.apiKeyId === undefined ||
    state.environment === undefined
  ) {
    return undefined;
  }

  return {
    requestId: state.requestId,
    organizationId: state.organizationId,
    apiKeyId: state.apiKeyId,
    ...(state.actorId === undefined ? {} : { actorId: state.actorId }),
    operation: state.operation,
    environment: state.environment,
    outcome: input.outcome,
    httpStatus: input.httpStatus,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(state.usage === undefined ? {} : { usage: state.usage }),
    ...(state.models === undefined ? {} : { models: state.models }),
    ...(input.meteringStatus === undefined
      ? {}
      : { meteringStatus: input.meteringStatus }),
    totalMs: input.totalMs,
    ...(state.downstreamMs === undefined
      ? {}
      : { downstreamMs: state.downstreamMs }),
    ...(state.aiProcessingMs === undefined
      ? {}
      : { aiProcessingMs: state.aiProcessingMs }),
    ...(state.idempotentReplay === undefined
      ? {}
      : { idempotentReplay: state.idempotentReplay }),
    ...(state.modelCalled === undefined
      ? {}
      : { modelCalled: state.modelCalled }),
    ...(state.quotaUnverified === undefined
      ? {}
      : { quotaUnverified: state.quotaUnverified }),
  };
}
