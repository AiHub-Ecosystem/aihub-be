import {
  type MeteringMode,
  OPERATION_CATALOG,
} from '@/catalog/operation-catalog';
import type { DownstreamId } from '@/downstream/downstream.types';
import type { QuotaCounterPort } from '@/modules/gateway/application/quota-counter.port';
import type {
  MeteringFinalizeInput,
  MeteringFinalizerPort,
  MeteringStatus,
} from './metering-finalizer.port';
import type { MeteringFailureLoggerPort } from './metering-logger.port';
import { normalizeMeteringTelemetry } from './metering.telemetry';
import type { UsageRecord, UsageRepositoryPort } from './usage-repository.port';

export const DOWNSTREAM_USAGE_REPORTING = {
  'ai-writing': false,
  'ai-speaking': false,
} as const satisfies Record<DownstreamId, boolean>;

const NOOP_LOGGER: MeteringFailureLoggerPort = {
  writeFailed: () => undefined,
};
const NOOP_QUOTA_COUNTER: Pick<QuotaCounterPort, 'increment'> = {
  increment: async () => undefined,
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
  readonly usageReportingExpected: boolean;
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
  if (complete) {
    return 'complete';
  }
  return input.usageReportingExpected ? 'missing_usage' : 'not_applicable';
}

function usageRecord(input: MeteringFinalizeInput): UsageRecord {
  const telemetry = normalizeMeteringTelemetry(input);
  const operation = OPERATION_CATALOG[input.operation];
  const mode = operation.meteringMode;
  const meteringStatus =
    input.quotaUnverified === true
      ? 'quota_unverified'
      : resolveMeteringStatus({
          mode,
          usageReportingExpected:
            DOWNSTREAM_USAGE_REPORTING[operation.downstream],
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
    private readonly quotaCounter: Pick<
      QuotaCounterPort,
      'increment'
    > = NOOP_QUOTA_COUNTER,
  ) {}

  async finalize(input: MeteringFinalizeInput): Promise<void> {
    let record = usageRecord(input);
    if (input.quotaTracked === true && record.billableRequests === 1) {
      try {
        await this.quotaCounter.increment({
          organizationId: input.organizationId,
        });
      } catch {
        record = { ...record, meteringStatus: 'quota_unverified' };
      }
    }
    // Announced only once the record is final, after the quota mutation that
    // can still change the status. A reader that learns the status earlier
    // would report `missing_usage` for a record persisted as
    // `quota_unverified`.
    input.onStatusWritten?.(record.meteringStatus);
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
