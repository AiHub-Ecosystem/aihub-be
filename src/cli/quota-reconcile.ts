import { internalError } from '@/common/errors/app-error';
import {
  type RedisQuotaReconciliationClient,
  RedisQuotaReconciliationCounter,
} from '@/modules/gateway/infrastructure/redis-quota-reconciliation.counter';
import { PostgresQuotaReconciliationRepository } from '@/modules/metering/infrastructure/billing/postgres-quota-reconciliation.repository';
import {
  type QuotaReconciliationEvent,
  QuotaReconciliationService,
  type QuotaReconciliationSummary,
} from '@/modules/metering/public/quota-reconciliation';
import { connectCliRedis } from './cli-redis';
import { createOperatorMeteringClient } from './operator-metering-client';

export { parseTargetMonth } from '@/modules/metering/public/quota-reconciliation';

interface QuotaReconciliationCliInput {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly requestedMonth?: string;
  readonly now?: Date;
  readonly dryRun?: boolean;
  readonly emit?: (line: string) => void;
}

export function formatQuotaReconciliationEvent(
  event: QuotaReconciliationEvent,
): string {
  if (event.type === 'reconciled' || event.type === 'preview') {
    return JSON.stringify({
      event:
        event.type === 'preview'
          ? 'quota_reconcile_preview'
          : 'quota_reconciled',
      organization_id: event.result.organizationId,
      month: event.result.month,
      billable_count: event.result.billableCount,
      quota: event.result.quota,
      over_quota: event.result.overQuota,
      excess: event.result.excess,
    });
  }

  if (event.type === 'drift_corrected' || event.type === 'drift_preview') {
    return JSON.stringify({
      event:
        event.type === 'drift_preview'
          ? 'quota_reconciliation_drift_preview'
          : 'quota_reconciliation_drift_corrected',
      organization_id: event.organizationId,
      month: event.month,
      postgres_count: event.postgresCount,
      redis_count: event.redisCount,
      drift_requests: event.driftRequests,
      threshold_requests: event.thresholdRequests,
    });
  }

  if (event.type === 'failed') {
    return JSON.stringify({
      event: 'quota_reconcile_failed',
      organization_id: event.organizationId,
      month: event.month,
      reconciled: event.reconciled,
      over_quota: event.overQuota,
      drifted_organizations: event.driftedOrganizations,
      drift_requests: event.driftRequests,
      failed: event.failed,
    });
  }

  return JSON.stringify({
    event:
      event.type === 'preview_summary'
        ? 'quota_reconcile_preview_summary'
        : 'quota_reconcile_summary',
    month: event.month,
    reconciled: event.summary.reconciled,
    over_quota: event.summary.overQuota,
    drifted_organizations: event.summary.driftedOrganizations,
    drift_requests: event.summary.driftRequests,
    status:
      event.summary.driftRequests > 0 || event.summary.overQuota > 0
        ? 'attention'
        : 'healthy',
    failed: event.summary.failed,
  });
}

/**
 * The gateway's request-path client gives a command 100 ms, which a Redis
 * reached over the network can miss: the write failed on production and the
 * process then stayed alive, because `quit()` on that client rejects without
 * closing the socket. This one connects first, allows seconds, and always lets
 * go of the socket.
 */
async function connectRedis(
  url: string,
): Promise<RedisQuotaReconciliationClient> {
  const redis = await connectCliRedis(url);
  return {
    get: (key) => redis.get(key),
    set: (key, value, mode, seconds) => redis.set(key, value, mode, seconds),
    quit: async () => {
      await redis.quit().catch(() => undefined);
      redis.disconnect();
    },
  };
}

export async function runQuotaReconciliationCommand(
  input: QuotaReconciliationCliInput,
): Promise<QuotaReconciliationSummary> {
  if (input.databaseUrl.trim().length === 0) {
    throw internalError('DATABASE_URL is required');
  }
  if (input.redisUrl.trim().length === 0) {
    throw internalError('REDIS_URL is required');
  }

  const repository = new PostgresQuotaReconciliationRepository(
    await createOperatorMeteringClient(input.databaseUrl),
  );
  let redisClient: RedisQuotaReconciliationClient;
  try {
    redisClient = await connectRedis(input.redisUrl);
  } catch (error) {
    await repository.close();
    throw error;
  }

  const counter = new RedisQuotaReconciliationCounter(redisClient);
  const service = new QuotaReconciliationService(
    repository,
    counter,
    () => input.now ?? new Date(),
  );
  const emit = input.emit ?? console.log;

  try {
    return await service.reconcile(
      input.requestedMonth,
      (event) => emit(formatQuotaReconciliationEvent(event)),
      { dryRun: input.dryRun === true },
    );
  } finally {
    await counter.close();
    await repository.close();
  }
}
