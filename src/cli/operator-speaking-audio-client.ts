import type { PostgresSpeakingAudioUploadRepository } from '@/modules/speaking/infrastructure/postgres-speaking-audio-upload.repository';

import { operatorPostgresApplicationName } from './operator-postgres-application-name';

export async function createOperatorSpeakingAudioClient(
  databaseUrl: string,
): Promise<PostgresSpeakingAudioUploadRepository & { close(): Promise<void> }> {
  const [
    { createOperatorPrismaClient },
    { PostgresSpeakingAudioUploadRepository },
  ] = await Promise.all([
    import('@/modules/persistence/infrastructure/prisma-client'),
    import(
      '@/modules/speaking/infrastructure/postgres-speaking-audio-upload.repository'
    ),
  ]);
  const holder = createOperatorPrismaClient(
    'runtime',
    databaseUrl,
    operatorPostgresApplicationName('runtime'),
  );
  return Object.assign(
    new PostgresSpeakingAudioUploadRepository(holder.prisma),
    { close: () => holder.close() },
  );
}
