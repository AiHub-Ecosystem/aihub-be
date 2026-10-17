export async function createOperatorIdentityClient(databaseUrl: string) {
  const [{ createIdentityTransactionRunner }, { createOperatorPrismaClient }] =
    await Promise.all([
      import(
        '@/modules/identity/shared/infrastructure/postgres-identity.client'
      ),
      import('@/modules/persistence/infrastructure/prisma-client'),
    ]);
  const holder = createOperatorPrismaClient('control-plane', databaseUrl);
  return Object.assign(createIdentityTransactionRunner(holder.prisma), {
    close: () => holder.close(),
  });
}
