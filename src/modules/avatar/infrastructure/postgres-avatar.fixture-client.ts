import { createPrismaClient } from '@/modules/persistence/persistence.module';
import type { PrismaClient } from '@prisma-client/client';

type AvatarFixtureClient = PrismaClient & { close(): Promise<void> };

/** Test-only Prisma client used by the unchanged avatar database spec. */
export function createAvatarQueryClient(
  databaseUrl: string,
): AvatarFixtureClient {
  if (databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL is missing');
  }

  const holder = createPrismaClient('integration-test', databaseUrl);
  return Object.assign(holder.prisma, { close: holder.close });
}
