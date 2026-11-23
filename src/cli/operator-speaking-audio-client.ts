import {
  type SpeakingAudioUploadRepositoryPort,
  createOperatorSpeakingAudioUploadRepository,
} from '@/modules/speaking/public/speaking-audio-upload-sweep';

import { operatorPostgresApplicationName } from './operator-postgres-application-name';

export async function createOperatorSpeakingAudioClient(
  databaseUrl: string,
): Promise<SpeakingAudioUploadRepositoryPort & { close(): Promise<void> }> {
  const { createOperatorPrismaClient } = await import(
    '@/modules/persistence/infrastructure/prisma-client'
  );
  const holder = createOperatorPrismaClient(
    'runtime',
    databaseUrl,
    operatorPostgresApplicationName('runtime'),
  );
  return Object.assign(
    createOperatorSpeakingAudioUploadRepository(holder.prisma),
    { close: () => holder.close() },
  );
}
