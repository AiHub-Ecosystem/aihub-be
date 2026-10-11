export async function createOperatorAvatarClient(databaseUrl: string) {
  const [{ createSharedPrismaClients }, { PostgresAvatarRepository }] =
    await Promise.all([
      import('@/modules/persistence/infrastructure/prisma-client'),
      import('@/modules/avatar/infrastructure/postgres-avatar.repository'),
    ]);
  const clients = createSharedPrismaClients({
    databaseUrl,
    controlPlaneDatabaseUrl: undefined,
    controlPlaneReadDatabaseUrl: undefined,
  });
  return Object.assign(new PostgresAvatarRepository(clients.runtime.prisma), {
    close: () => clients.close(),
  });
}
