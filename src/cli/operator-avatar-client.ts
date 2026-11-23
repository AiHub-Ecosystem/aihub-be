import {
  type AvatarRepositoryPort,
  createOperatorAvatarRepository,
} from '@/modules/avatar/public/avatar-sweep';

import { operatorPostgresApplicationName } from './operator-postgres-application-name';

export async function createOperatorAvatarClient(
  databaseUrl: string,
): Promise<AvatarRepositoryPort & { close(): Promise<void> }> {
  const { createOperatorPrismaClient } = await import(
    '@/modules/persistence/infrastructure/prisma-client'
  );
  const holder = createOperatorPrismaClient(
    'runtime',
    databaseUrl,
    operatorPostgresApplicationName('runtime'),
  );
  return Object.assign(createOperatorAvatarRepository(holder.prisma), {
    close: () => holder.close(),
  });
}
