import { createRedisGatewayClient } from '@/modules/gateway/infrastructure/redis-gateway.client';
import { RedisQuotaReconciliationCounter } from '@/modules/gateway/infrastructure/redis-quota-reconciliation.counter';
import {
  type QuotaReconciliationEvent,
  QuotaReconciliationService,
  type QuotaReconciliationSummary,
} from '@/modules/metering/application/quota-reconciliation';
import { createPostgresQuotaReconciliationRepository } from '@/modules/metering/infrastructure/postgres-quota-reconciliation.repository';

export { parseTargetMonth } from '@/modules/metering/application/quota-reconciliation';

interface QuotaReconciliationCliInput {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly requestedMonth?: string;
  readonly now?: Date;
  readonly emit?: (line: string) => void;
}

export function formatQuotaReconciliationEvent(
  event: QuotaReconciliationEvent,
): string {
  if (event.type === 'reconciled') {
    return JSON.stringify({
      event: 'quota_reconciled',
      organization_id: event.result.organizationId,
      month: event.result.month,
      billable_count: event.result.billableCount,
      quota: event.result.quota,
      over_quota: event.result.overQuota,
      excess: event.result.excess,
    });
  }

  if (event.type === 'failed') {
    return JSON.stringify({
      event: 'quota_reconcile_failed',
      organization_id: event.organizationId,
      month: event.month,
      reconciled: event.reconciled,
      over_quota: event.overQuota,
      failed: event.failed,
    });
  }

  return JSON.stringify({
    event: 'quota_reconcile_summary',
    month: event.month,
    reconciled: event.summary.reconciled,
    over_quota: event.summary.overQuota,
    failed: event.summary.failed,
  });
}

export async function runQuotaReconciliationCommand(
  input: QuotaReconciliationCliInput,
): Promise<QuotaReconciliationSummary> {
  if (input.databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL is required');
  }
  if (input.redisUrl.trim().length === 0) {
    throw new Error('REDIS_URL is required');
  }

  const repository = createPostgresQuotaReconciliationRepository(
    input.databaseUrl,
  );
  const redisClient = createRedisGatewayClient(input.redisUrl);
  if (redisClient === undefined) {
    await repository.close();
    throw new Error('REDIS_URL is required');
  }

  const counter = new RedisQuotaReconciliationCounter(redisClient);
  const service = new QuotaReconciliationService(
    repository,
    counter,
    () => input.now ?? new Date(),
  );
  const emit = input.emit ?? console.log;

  try {
    return await service.reconcile(input.requestedMonth, (event) => {
      emit(formatQuotaReconciliationEvent(event));
    });
  } finally {
    await counter.close();
    await repository.close();
  }
}
