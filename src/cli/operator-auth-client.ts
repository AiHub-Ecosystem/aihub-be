import type { AuthRepositoryClient } from '@/modules/auth/shared/infrastructure/auth-prisma';
import { operatorPostgresApplicationName } from './operator-postgres-application-name';

export async function createOperatorAuthClient(
  databaseUrl: string,
): Promise<AuthRepositoryClient & { close(): Promise<void> }> {
  const { createOperatorPrismaClient } = await import(
    '@/modules/persistence/infrastructure/prisma-client'
  );
  const holder = createOperatorPrismaClient(
    'control-plane',
    databaseUrl,
    operatorPostgresApplicationName('control-plane'),
  );
  return Object.assign(holder.prisma, {
    close: () => holder.close(),
  });
}
