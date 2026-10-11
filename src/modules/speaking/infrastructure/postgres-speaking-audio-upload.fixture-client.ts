import { createPrismaClient } from '@/modules/persistence/persistence.module';
import { PrismaClient } from '@prisma-client/client';

type SpeakingAudioTestPrismaClient = PrismaClient & {
  close(): Promise<void>;
};

/** Test-only factory retained for the unchanged database-lane fixtures. */
export function createSpeakingAudioQueryClient(
  databaseUrl: string,
): SpeakingAudioTestPrismaClient {
  if (databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL is missing');
  }

  const holder = createPrismaClient('integration-test', databaseUrl);
  return Object.assign(holder.prisma, { close: holder.close });
}
