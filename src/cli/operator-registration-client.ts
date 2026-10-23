export async function createOperatorRegistrationClient(databaseUrl: string) {
  const [
    { createOperatorPrismaClient },
    { PostgresPendingRegistrationRecords },
  ] = await Promise.all([
    import('@/modules/persistence/infrastructure/prisma-client'),
    import(
      '@/modules/auth/accounts/infrastructure/postgres-pending-registration-records'
    ),
  ]);
  const holder = createOperatorPrismaClient('control-plane', databaseUrl);
  return Object.assign(new PostgresPendingRegistrationRecords(holder.prisma), {
    close: () => holder.close(),
  });
}
