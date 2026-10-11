export async function createOperatorMeteringClient(databaseUrl: string) {
  const { createSharedPrismaClients } = await import(
    '@/modules/persistence/infrastructure/prisma-client'
  );
  const clients = createSharedPrismaClients({
    databaseUrl,
    controlPlaneDatabaseUrl: undefined,
    controlPlaneReadDatabaseUrl: undefined,
  });
  return Object.assign(clients.runtime.prisma, {
    close: () => clients.close(),
  });
}
