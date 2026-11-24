import type { PrismaMeteringClient } from '@/modules/metering/infrastructure/usage-recording/prisma-metering.client';

import { createFixturePrismaClient } from './fixture-prisma-client';

/** Test-only factory used by unchanged database-lane fixtures. */
export function createPostgresMeteringClient(
  databaseUrl: string,
): PrismaMeteringClient {
  return createFixturePrismaClient(databaseUrl);
}
