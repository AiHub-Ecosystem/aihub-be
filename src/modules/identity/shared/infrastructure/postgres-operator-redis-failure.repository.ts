import type {
  OperatorRedisFailurePort,
  OperatorRedisFailureSeam,
} from '@/modules/identity/shared/application/operator-redis-failure.port';
import type { IdentityRepositoryClient } from './postgres-identity.client';

/** Fixed aggregate rows survive the one-shot operator process that writes them. */
export class PostgresOperatorRedisFailureRepository
  implements OperatorRedisFailurePort
{
  constructor(
    private readonly client: Pick<
      IdentityRepositoryClient,
      'operatorRedisFailure'
    >,
  ) {}

  async recordFailure(seam: OperatorRedisFailureSeam): Promise<void> {
    await this.client.operatorRedisFailure.update({
      where: { seam },
      data: { total: { increment: 1 } },
    });
  }
}
