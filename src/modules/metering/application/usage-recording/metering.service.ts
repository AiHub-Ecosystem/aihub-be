import {
  type MeteringMode,
  OPERATION_CATALOG,
  type OperationDef,
} from '@/catalog/operation-catalog';
import { isUsableCount } from '@/common/counts/is-usable-count';
import type { DownstreamId } from '@/downstream/downstream.types';
import type { QuotaCounterPort } from '@/modules/gateway/application/quota-counter.port';
import type {
  MeteringFinalizeInput,
  MeteringFinalizerPort,
  MeteringStatus,
} from './metering-finalizer.port';
import type { MeteringFailureLoggerPort } from './metering-logger.port';
import type {
  MeteringTelemetryPort,
  MeteringWriteOutcome,
} from './metering-telemetry.port';
import { normalizeMeteringTelemetry } from './metering.telemetry';
import type { UsageRecord, UsageRepositoryPort } from './usage-repository.port';

export const DOWNSTREAM_USAGE_REPORTING = {
  'ai-writing': false,
  'ai-speaking': true,
} as const satisfies Record<DownstreamId, boolean>;

/**
 * Bound on how long a Metering write may hold the request path (#229).
 * Healthy inserts land in 2-3ms (p99 <15ms); 100ms is ~7x that p99 and
 * 10x under the pool's 1s connect timeout, so a slow DB cannot push a full
 * second of latency onto a request that already finished its real work.
 */
export const METERING_WRITE_TIMEOUT_MS = 100;

const NOOP_LOGGER: MeteringFailureLoggerPort = {
  writeFailed: () => undefined,
};
const NOOP_QUOTA_COUNTER: Pick<QuotaCounterPort, 'increment'> = {
  increment: async () => undefined,
};
const NOOP_TELEMETRY: MeteringTelemetryPort = {
  writeDurationSeconds: () => undefined,
  writeFailed: () => undefined,
};

function nonNegativeInteger(value: number | undefined): number | undefined {
  return isUsableCount(value) ? value : undefined;
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
    [usage.inputTokens, usage.outputTokens, usage.totalTokens].every((value) =>
      isUsableCount(value),
    );
  if (complete) {
    return 'complete';
  }
  return input.usageReportingExpected ? 'missing_usage' : 'not_applicable';
}

function usageRecord(
  input: MeteringFinalizeInput,
  catalog: Readonly<
    Record<string, Pick<OperationDef, 'meteringMode' | 'downstream'>>
  >,
): UsageRecord {
  const telemetry = normalizeMeteringTelemetry(input);
  const operation =
    catalog[input.operation] ?? OPERATION_CATALOG[input.operation];
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
    mode === 'model' &&
    input.outcome === 'success' &&
    input.idempotentReplay !== true
      ? 1
      : 0;
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
    billingBasis: input.billingBasis ?? 'response',
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
    private readonly catalog: Readonly<
      Record<string, Pick<OperationDef, 'meteringMode' | 'downstream'>>
    > = OPERATION_CATALOG,
    private readonly telemetry: MeteringTelemetryPort = NOOP_TELEMETRY,
  ) {}

  async finalize(input: MeteringFinalizeInput): Promise<void> {
    let record = usageRecord(input, this.catalog);
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
    await this.writeBounded(record);
  }

  private async writeBounded(record: UsageRecord): Promise<void> {
    const startedAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol('timedOut');
    const timeout = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), METERING_WRITE_TIMEOUT_MS);
    });
    // The insert that outlives the race still lands when it lands; nothing
    // retries it, so it cannot duplicate a record another attempt wrote.
    const landed = this.repository
      .insert(record)
      .then(() => ({ kind: 'landed' as const }))
      .catch((_error: unknown) => ({ kind: 'failed' as const }));
    try {
      const outcome = await Promise.race([landed, timeout]);
      if (outcome === timedOut) {
        this.telemetry.writeDurationSeconds(
          'timeout',
          (performance.now() - startedAt) / 1000,
        );
        this.telemetry.writeFailed('timeout');
        this.logLost(record, 'timeout');
        return;
      }
      this.telemetry.writeDurationSeconds(
        outcome.kind === 'landed' ? 'success' : 'error',
        (performance.now() - startedAt) / 1000,
      );
      if (outcome.kind === 'landed') {
        return;
      }
      this.telemetry.writeFailed('error');
      this.logLost(record, 'error');
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private logLost(
    record: UsageRecord,
    reason: Exclude<MeteringWriteOutcome, 'success'>,
  ): void {
    try {
      this.logger.writeFailed(record, reason);
    } catch {
      // A telemetry breadcrumb must never change the customer response.
    }
  }
}
