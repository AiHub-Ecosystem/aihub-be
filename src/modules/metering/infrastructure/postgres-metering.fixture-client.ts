import { createFixturePrismaClient } from '@/modules/persistence/persistence.module';
import type { PrismaMeteringClient } from './prisma-metering.client';

/** Test-only factory used by unchanged database-lane fixtures. */
export function createPostgresMeteringClient(
  databaseUrl: string,
): PrismaMeteringClient {
  return createFixturePrismaClient(databaseUrl);
}
