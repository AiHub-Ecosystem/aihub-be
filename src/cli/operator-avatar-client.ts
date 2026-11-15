import { operatorPostgresApplicationName } from './operator-postgres-application-name';

export async function createOperatorAvatarClient(databaseUrl: string) {
  const [{ createOperatorPrismaClient }, { PostgresAvatarRepository }] =
    await Promise.all([
      import('@/modules/persistence/infrastructure/prisma-client'),
      import('@/modules/avatar/infrastructure/postgres-avatar.repository'),
    ]);
  const holder = createOperatorPrismaClient(
    'runtime',
    databaseUrl,
    operatorPostgresApplicationName('runtime'),
  );
  return Object.assign(new PostgresAvatarRepository(holder.prisma), {
    close: () => holder.close(),
  });
}
