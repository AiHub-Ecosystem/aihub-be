import { createPrismaMeteringClient } from '@/modules/metering/infrastructure/prisma-metering.client';

export async function createOperatorMeteringClient(databaseUrl: string) {
  const { createSharedPrismaClients } = await import(
    '@/modules/persistence/infrastructure/prisma-client'
  );
  const clients = createSharedPrismaClients({
    databaseUrl,
    controlPlaneDatabaseUrl: undefined,
    controlPlaneReadDatabaseUrl: undefined,
  });
  return createPrismaMeteringClient(
    () => clients.runtime.prisma,
    () => clients.close(),
  );
}
