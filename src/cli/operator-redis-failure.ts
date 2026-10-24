import type {
  OperatorRedisFailurePort,
  OperatorRedisFailureSeam,
} from '@/modules/identity/shared/application/operator-redis-failure.port';
import { PostgresOperatorRedisFailureRepository } from '@/modules/identity/shared/infrastructure/postgres-operator-redis-failure.repository';
import { createOperatorIdentityClient } from './operator-identity-client';

/** Reopens only after the mutation's client closed, within existing CLI headroom. */
export async function reportOperatorRedisFailure(
  databaseUrl: string,
  seam: OperatorRedisFailureSeam,
  emit: (line: string) => void,
  recordFailure?: OperatorRedisFailurePort['recordFailure'],
): Promise<void> {
  try {
    if (recordFailure !== undefined) {
      await recordFailure(seam);
      return;
    }
    const client = await createOperatorIdentityClient(databaseUrl);
    try {
      await new PostgresOperatorRedisFailureRepository(client).recordFailure(
        seam,
      );
    } finally {
      await client.close();
    }
  } catch {
    emit('The Redis failure could not be persisted for monitoring.');
  }
}
