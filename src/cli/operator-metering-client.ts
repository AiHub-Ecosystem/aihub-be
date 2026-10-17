export async function createOperatorMeteringClient(databaseUrl: string) {
  const { createOperatorPrismaClient } = await import(
    '@/modules/persistence/infrastructure/prisma-client'
  );
  const holder = createOperatorPrismaClient('runtime', databaseUrl);
  return Object.assign(holder.prisma, { close: () => holder.close() });
}
