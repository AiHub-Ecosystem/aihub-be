export async function createOperatorAvatarClient(databaseUrl: string) {
  const [{ createPrismaClient }, { PostgresAvatarRepository }] =
    await Promise.all([
      import('@/modules/persistence/infrastructure/prisma-client'),
      import('@/modules/avatar/infrastructure/postgres-avatar.repository'),
    ]);
  const holder = createPrismaClient('runtime', databaseUrl);
  return Object.assign(new PostgresAvatarRepository(holder.prisma), {
    close: holder.close,
  });
}
