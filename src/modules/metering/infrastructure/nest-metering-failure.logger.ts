import { Logger } from '@nestjs/common';

import type { MeteringFailureLoggerPort } from '../application/metering-logger.port';
import type { UsageRecord } from '../application/usage-repository.port';

function safeUsage(
  usage: UsageRecord['usage'],
): Record<string, number> | undefined {
  if (usage === undefined) {
    return undefined;
  }

  return {
    ...(usage.inputTokens === undefined
      ? {}
      : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined
      ? {}
      : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined
      ? {}
      : { totalTokens: usage.totalTokens }),
  };
}

function safeRecord(record: UsageRecord): Record<string, unknown> {
  return {
    requestId: record.requestId,
    organizationId: record.organizationId,
    apiKeyId: record.apiKeyId,
    ...(record.actorId === undefined ? {} : { actorId: record.actorId }),
    service: record.service,
    operation: record.operation,
    environment: record.environment,
    outcome: record.outcome,
    httpStatus: record.httpStatus,
    ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
    billableRequests: record.billableRequests,
    ...(record.usage === undefined ? {} : { usage: safeUsage(record.usage) }),
    ...(record.models === undefined
      ? {}
      : {
          models: record.models.map(({ provider, name }) => ({
            provider,
            name,
          })),
        }),
    meteringStatus: record.meteringStatus,
    totalMs: record.totalMs,
    ...(record.downstreamMs === undefined
      ? {}
      : { downstreamMs: record.downstreamMs }),
    ...(record.aiProcessingMs === undefined
      ? {}
      : { aiProcessingMs: record.aiProcessingMs }),
  };
}

export class NestMeteringFailureLogger implements MeteringFailureLoggerPort {
  private readonly logger = new Logger(NestMeteringFailureLogger.name);

  writeFailed(record: UsageRecord): void {
    this.logger.error(
      JSON.stringify({
        event: 'metering_write_failed',
        record: safeRecord(record),
      }),
    );
  }
}
