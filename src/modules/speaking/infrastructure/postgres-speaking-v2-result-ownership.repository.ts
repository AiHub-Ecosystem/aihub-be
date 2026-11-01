import { databaseUnavailableError } from '@/common/postgres/postgres-unavailable-error';
import type {
  SpeakingV2ResultKind,
  SpeakingV2ResultOwner,
  SpeakingV2ResultOwnershipPort,
} from '@/modules/speaking/application/speaking-v2-result-ownership.port';
import type { PrismaClient } from '@prisma-client/client';

export class PostgresSpeakingV2ResultOwnershipRepository
  implements SpeakingV2ResultOwnershipPort
{
  constructor(private readonly client: PrismaClient) {}

  async record(
    owner: SpeakingV2ResultOwner,
    kind: SpeakingV2ResultKind,
    id: string,
  ): Promise<void> {
    try {
      await this.client.$executeRawUnsafe(
        `INSERT INTO speaking_v2_result_ownership
           (organization_id, environment, end_user_id, kind, id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        owner.organizationId,
        owner.environment,
        owner.endUserId,
        kind,
        id,
      );
    } catch (error) {
      throw databaseUnavailableError(
        error,
        'Speaking result ownership unavailable',
      );
    }
  }

  async findOwnedIds(
    owner: SpeakingV2ResultOwner,
    kind: SpeakingV2ResultKind,
    ids: readonly string[],
  ): Promise<readonly string[]> {
    if (ids.length === 0) return [];
    try {
      const rows = await this.client.$queryRawUnsafe<readonly { id: string }[]>(
        `SELECT id FROM speaking_v2_result_ownership
         WHERE organization_id = $1 AND environment = $2 AND end_user_id = $3
           AND kind = $4 AND id = ANY($5::text[])`,
        owner.organizationId,
        owner.environment,
        owner.endUserId,
        kind,
        [...ids],
      );
      return rows.map(({ id }) => id);
    } catch (error) {
      throw databaseUnavailableError(
        error,
        'Speaking result ownership unavailable',
      );
    }
  }
}
