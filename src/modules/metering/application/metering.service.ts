import {
  type MeteringMode,
  OPERATION_CATALOG,
} from '../../../catalog/operation-catalog';
import type { OperationId } from '../../../catalog/operation-id';
import type {
  MeteringFinalizeInput,
  MeteringFinalizerPort,
} from '../../../common/metering/metering-finalizer.port';
import type { MeteringStatus } from '../../../common/metering/metering.types';
import { normalizeMeteringTelemetry } from '../../../common/metering/telemetry';
import type { MeteringFailureLoggerPort } from './metering-logger.port';
import type { UsageRecord, UsageRepositoryPort } from './usage-repository.port';

const NOOP_LOGGER: MeteringFailureLoggerPort = {
  writeFailed: () => undefined,
};

function nonNegativeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : undefined;
}

export function resolveMeteringStatus(input: {
  readonly mode: MeteringMode;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
  readonly modelCalled?: boolean;
  readonly quotaUnverified?: boolean;
}): MeteringStatus {
  if (input.quotaUnverified === true) {
    return 'quota_unverified';
  }
  if (input.mode === 'none') {
    return 'not_applicable';
  }
  if (input.modelCalled !== true) {
    return 'not_applicable';
  }

  const usage = input.usage;
  const complete =
    usage?.inputTokens !== undefined &&
    usage.outputTokens !== undefined &&
    usage.totalTokens !== undefined &&
    [usage.inputTokens, usage.outputTokens, usage.totalTokens].every(
      (value) => Number.isInteger(value) && value >= 0,
    );
  return complete ? 'complete' : 'missing_usage';
}

function operationMode(operation: OperationId): MeteringMode {
  return OPERATION_CATALOG[operation].meteringMode;
}

function usageRecord(input: MeteringFinalizeInput): UsageRecord {
  const telemetry = normalizeMeteringTelemetry(input);
  const mode = operationMode(input.operation);
  const meteringStatus =
    input.meteringStatus ??
    resolveMeteringStatus({
      mode,
      ...(telemetry.usage === undefined ? {} : { usage: telemetry.usage }),
      ...(input.quotaUnverified === undefined
        ? {}
        : { quotaUnverified: input.quotaUnverified }),
      ...(input.modelCalled === undefined
        ? { modelCalled: input.outcome === 'success' }
        : { modelCalled: input.modelCalled }),
    });
  const billableRequests =
    input.outcome === 'success' && input.idempotentReplay !== true ? 1 : 0;
  const actorId = safeText(input.actorId);
  const errorCode = safeText(input.errorCode);
  const downstreamMs = nonNegativeInteger(input.downstreamMs);

  return {
    requestId: input.requestId,
    organizationId: input.organizationId,
    apiKeyId: input.apiKeyId,
    ...(actorId === undefined ? {} : { actorId }),
    service: input.operation.split('.')[0] ?? 'unknown',
    operation: input.operation,
    environment: input.environment,
    outcome: input.outcome,
    httpStatus: input.httpStatus,
    ...(errorCode === undefined ? {} : { errorCode }),
    billableRequests,
    ...(telemetry.usage === undefined ? {} : { usage: telemetry.usage }),
    ...(telemetry.models === undefined ? {} : { models: telemetry.models }),
    meteringStatus,
    totalMs: nonNegativeInteger(input.totalMs) ?? 0,
    ...(downstreamMs === undefined ? {} : { downstreamMs }),
    ...(telemetry.aiProcessingMs === undefined
      ? {}
      : { aiProcessingMs: telemetry.aiProcessingMs }),
  };
}

export class MeteringService implements MeteringFinalizerPort {
  constructor(
    private readonly repository: UsageRepositoryPort,
    private readonly logger: MeteringFailureLoggerPort = NOOP_LOGGER,
  ) {}

  async finalize(input: MeteringFinalizeInput): Promise<void> {
    const record = usageRecord(input);
    try {
      await this.repository.insert(record);
    } catch {
      try {
        this.logger.writeFailed(record);
      } catch {
        // A telemetry breadcrumb must never change the customer response.
      }
    }
  }
}
