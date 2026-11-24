import { createFixturePrismaClient } from './fixture-prisma-client';

/** Test-only factory retained for the unchanged database-lane fixtures. */
export function createSpeakingAudioQueryClient(
  databaseUrl: string,
): ReturnType<typeof createFixturePrismaClient> {
  return createFixturePrismaClient(databaseUrl);
}
