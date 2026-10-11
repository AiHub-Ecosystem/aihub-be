export async function createOperatorIdentityClient(databaseUrl: string) {
  const [{ createIdentityTransactionRunner }, { createSharedPrismaClients }] =
    await Promise.all([
      import(
        '@/modules/identity/shared/infrastructure/postgres-identity.client'
      ),
      import('@/modules/persistence/infrastructure/prisma-client'),
    ]);
  const clients = createSharedPrismaClients({
    databaseUrl: undefined,
    controlPlaneDatabaseUrl: databaseUrl,
    controlPlaneReadDatabaseUrl: undefined,
  });
  return {
    ...createIdentityTransactionRunner(() => clients.controlPlane.prisma),
    close: () => clients.close(),
  };
}
