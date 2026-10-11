export async function createOperatorAvatarClient(databaseUrl: string) {
  const [
    { createSharedPrismaClients },
    { PostgresAvatarRepository },
    { createPrismaAvatarQueryClient },
  ] = await Promise.all([
    import('@/modules/persistence/infrastructure/prisma-client'),
    import('@/modules/avatar/infrastructure/postgres-avatar.repository'),
    import('@/modules/avatar/infrastructure/prisma-avatar.client'),
  ]);
  const clients = createSharedPrismaClients({
    databaseUrl,
    controlPlaneDatabaseUrl: undefined,
    controlPlaneReadDatabaseUrl: undefined,
  });
  return Object.assign(
    new PostgresAvatarRepository(
      createPrismaAvatarQueryClient(() => clients.runtime.prisma),
    ),
    { close: () => clients.close() },
  );
}
