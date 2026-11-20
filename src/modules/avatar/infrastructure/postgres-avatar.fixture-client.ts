import { createFixturePrismaClient } from '@/modules/persistence/persistence.module';

/** Test-only Prisma client used by the unchanged avatar database spec. */
export function createAvatarQueryClient(
  databaseUrl: string,
): ReturnType<typeof createFixturePrismaClient> {
  return createFixturePrismaClient(databaseUrl);
}
