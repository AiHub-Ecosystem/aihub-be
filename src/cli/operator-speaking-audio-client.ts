export async function createOperatorSpeakingAudioClient(databaseUrl: string) {
  const [
    { createOperatorPrismaClient },
    { PostgresSpeakingAudioUploadRepository },
  ] = await Promise.all([
    import('@/modules/persistence/infrastructure/prisma-client'),
    import(
      '@/modules/speaking/infrastructure/postgres-speaking-audio-upload.repository'
    ),
  ]);
  const holder = createOperatorPrismaClient('runtime', databaseUrl);
  return Object.assign(
    new PostgresSpeakingAudioUploadRepository(holder.prisma),
    { close: () => holder.close() },
  );
}
