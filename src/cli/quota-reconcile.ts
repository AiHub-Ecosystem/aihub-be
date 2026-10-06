import {
  type RedisQuotaReconciliationClient,
  RedisQuotaReconciliationCounter,
} from '@/modules/gateway/infrastructure/redis-quota-reconciliation.counter';
import { createPostgresQuotaReconciliationRepository } from '@/modules/metering/infrastructure/postgres-quota-reconciliation.repository';
import {
  type QuotaReconciliationEvent,
  QuotaReconciliationService,
  type QuotaReconciliationSummary,
} from '@/modules/metering/public/quota-reconciliation';
import Redis from 'ioredis';

export { parseTargetMonth } from '@/modules/metering/public/quota-reconciliation';

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
  const redis = new Redis(url, {
    commandTimeout: 5_000,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
  } catch (error) {
    redis.disconnect();
    throw error;
  }
  return {
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
    throw new Error('DATABASE_URL is required');
  }
  if (input.redisUrl.trim().length === 0) {
    throw new Error('REDIS_URL is required');
  }

  const repository = createPostgresQuotaReconciliationRepository(
    input.databaseUrl,
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
    return await service.reconcile(input.requestedMonth, (event) => {
      emit(formatQuotaReconciliationEvent(event));
    });
  } finally {
    await counter.close();
    await repository.close();
  }
}
