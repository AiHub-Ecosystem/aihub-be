import { internalError } from '@/common/errors/app-error';
import { PostgresIdempotencyRepository } from '@/modules/idempotency/infrastructure/postgres-idempotency.repository';
import { createOperatorMeteringClient } from './operator-metering-client';

export interface IdempotencyCleanupCliInput {
  readonly databaseUrl: string;
  readonly now?: Date;
  readonly cutoffSource?: 'process' | 'database';
  readonly cleanup?: (cutoff: Date) => Promise<number>;
  readonly emit?: (line: string) => void;
}

async function cleanupExpired(
  databaseUrl: string,
  cutoff: Date,
): Promise<number> {
  const client = await createOperatorMeteringClient(databaseUrl);
  try {
    return await new PostgresIdempotencyRepository(client).cleanupExpired(
      cutoff,
    );
  } finally {
    await client.close();
  }
}

export async function runIdempotencyCleanupCommand(
  input: IdempotencyCleanupCliInput,
): Promise<number> {
  if (input.databaseUrl.trim().length === 0) {
    throw internalError('DATABASE_URL is required');
  }

  const cutoff = input.now ?? new Date();
  const cleanup =
    input.cleanup ?? ((at) => cleanupExpired(input.databaseUrl, at));
  const deleted = await cleanup(cutoff);
  const emit = input.emit ?? console.log;
  emit(
    JSON.stringify({
      event: 'idempotency_cleanup_completed',
      cutoff: cutoff.toISOString(),
      cutoff_source: input.cutoffSource ?? 'process',
      deleted,
    }),
  );
  return deleted;
}
