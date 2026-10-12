export async function createOperatorSpeakingAudioClient(databaseUrl: string) {
  const [{ createPrismaClient }, { PostgresSpeakingAudioUploadRepository }] =
    await Promise.all([
      import('@/modules/persistence/infrastructure/prisma-client'),
      import(
        '@/modules/speaking/infrastructure/postgres-speaking-audio-upload.repository'
      ),
    ]);
  const holder = createPrismaClient('runtime', databaseUrl);
  return Object.assign(
    new PostgresSpeakingAudioUploadRepository(holder.prisma),
    { close: () => holder.close() },
  );
}
