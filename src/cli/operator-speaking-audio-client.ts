export async function createOperatorSpeakingAudioClient(databaseUrl: string) {
  const [
    { createSharedPrismaClients },
    { PostgresSpeakingAudioUploadRepository },
    { createPrismaSpeakingAudioQueryClient },
  ] = await Promise.all([
    import('@/modules/persistence/infrastructure/prisma-client'),
    import(
      '@/modules/speaking/infrastructure/postgres-speaking-audio-upload.repository'
    ),
    import('@/modules/speaking/infrastructure/prisma-speaking-audio.client'),
  ]);
  const clients = createSharedPrismaClients({
    databaseUrl,
    controlPlaneDatabaseUrl: undefined,
    controlPlaneReadDatabaseUrl: undefined,
  });
  return Object.assign(
    new PostgresSpeakingAudioUploadRepository(
      createPrismaSpeakingAudioQueryClient(() => clients.runtime.prisma),
    ),
    { close: () => clients.close() },
  );
}
