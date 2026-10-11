import { createPrismaClient } from '@/modules/persistence/persistence.module';
import type { PrismaMeteringClient } from './prisma-metering.client';

/** Test-only factory used by unchanged database-lane fixtures. */
export function createPostgresMeteringClient(
  databaseUrl: string,
): PrismaMeteringClient {
  if (databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL is missing');
  }

  const holder = createPrismaClient('integration-test', databaseUrl);
  return Object.assign(holder.prisma, { close: holder.close });
}
