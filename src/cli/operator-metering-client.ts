export async function createOperatorMeteringClient(databaseUrl: string) {
  const { createPrismaClient } = await import(
    '@/modules/persistence/infrastructure/prisma-client'
  );
  const holder = createPrismaClient('runtime', databaseUrl);
  return Object.assign(holder.prisma, { close: holder.close });
}
