import type { PrismaClientHolder } from '@/modules/persistence/persistence.module';

import { operatorPostgresApplicationName } from './operator-postgres-application-name';

export async function createOperatorMeteringClient(
  databaseUrl: string,
): Promise<PrismaClientHolder['prisma'] & { close(): Promise<void> }> {
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
