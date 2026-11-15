import { operatorPostgresApplicationName } from './operator-postgres-application-name';

export async function createOperatorRegistrationClient(databaseUrl: string) {
  const [
    { createOperatorPrismaClient },
    { createOperatorPendingRegistrationRecords },
  ] = await Promise.all([
    import('@/modules/persistence/infrastructure/prisma-client'),
    import('@/modules/auth/public/pending-registration-expiry'),
  ]);
  const holder = createOperatorPrismaClient(
    'control-plane',
    databaseUrl,
    operatorPostgresApplicationName('control-plane'),
  );
  return Object.assign(
    createOperatorPendingRegistrationRecords(holder.prisma),
    { close: () => holder.close() },
  );
}
