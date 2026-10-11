import { createFixturePrismaClient } from '@/modules/persistence/persistence.module';

/** Test-only factory retained for the unchanged database-lane fixtures. */
export function createSpeakingAudioQueryClient(databaseUrl: string) {
  return createFixturePrismaClient(databaseUrl);
}
