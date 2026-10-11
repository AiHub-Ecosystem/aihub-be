import { createIdentityTransactionRunner } from '@/modules/identity/shared/infrastructure/postgres-identity.client';
import { createSharedPrismaClients } from '@/modules/persistence/infrastructure/prisma-client';

export function createOperatorIdentityClient(databaseUrl: string) {
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
