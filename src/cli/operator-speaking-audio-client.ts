export async function createOperatorSpeakingAudioClient(databaseUrl: string) {
  const [
    { createSharedPrismaClients },
    { PostgresSpeakingAudioUploadRepository },
  ] = await Promise.all([
    import('@/modules/persistence/infrastructure/prisma-client'),
    import(
      '@/modules/speaking/infrastructure/postgres-speaking-audio-upload.repository'
    ),
  ]);
  const clients = createSharedPrismaClients({
    databaseUrl,
    controlPlaneDatabaseUrl: undefined,
    controlPlaneReadDatabaseUrl: undefined,
  });
  return Object.assign(
    new PostgresSpeakingAudioUploadRepository(clients.runtime.prisma),
    { close: () => clients.close() },
  );
}
