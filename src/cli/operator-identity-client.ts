import { operatorPostgresApplicationName } from './operator-postgres-application-name';

export async function createOperatorIdentityClient(databaseUrl: string) {
  const [{ createIdentityTransactionRunner }, { createOperatorPrismaClient }] =
    await Promise.all([
      import(
        '@/modules/identity/shared/infrastructure/postgres-identity.client'
      ),
      import('@/modules/persistence/infrastructure/prisma-client'),
    ]);
  const holder = createOperatorPrismaClient(
    'control-plane',
    databaseUrl,
    operatorPostgresApplicationName('control-plane'),
  );
  return Object.assign(createIdentityTransactionRunner(holder.prisma), {
    close: () => holder.close(),
  });
}
