import type { PrismaClientHolder } from '@/modules/persistence/persistence.module';

import { operatorPostgresApplicationName } from './operator-postgres-application-name';

export async function createOperatorIdentityClient(
  databaseUrl: string,
): Promise<PrismaClientHolder['prisma'] & { close(): Promise<void> }> {
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
