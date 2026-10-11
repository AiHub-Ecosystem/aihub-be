import { PrismaPg } from '@prisma/adapter-pg';

import { createPostgresPool } from '@/common/postgres/postgres-pool';
import { PrismaClient } from '@prisma-client/client';
import { createPrismaAvatarQueryClient } from './prisma-avatar.client';
import type { AvatarQueryClient } from './prisma-avatar.client';

/** Compatibility factory used by unchanged database-lane fixtures. */
export function createAvatarQueryClient(
  databaseUrl: string,
): AvatarQueryClient {
  if (databaseUrl.trim().length === 0) {
    const missingDatabaseUrl = (): never => {
      throw new Error('DATABASE_URL is missing');
    };
    return {
      query: async () => missingDatabaseUrl(),
      close: async () => undefined,
    };
  }

  const pool = createPostgresPool('integration-test', {
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 30_000,
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  return createPrismaAvatarQueryClient(
    () => prisma,
    async () => {
      try {
        await prisma.$disconnect();
      } finally {
        await pool.end();
      }
    },
  );
}
