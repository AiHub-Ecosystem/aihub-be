import { operatorPostgresApplicationName } from './operator-postgres-application-name';

export async function createOperatorMeteringClient(databaseUrl: string) {
  const { createOperatorPrismaClient } = await import(
    '@/modules/persistence/infrastructure/prisma-client'
  );
  const holder = createOperatorPrismaClient(
    'runtime',
    databaseUrl,
    operatorPostgresApplicationName('runtime'),
  );
  return Object.assign(holder.prisma, { close: () => holder.close() });
}
