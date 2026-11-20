import type { PostgresWritingChartRevocationAuditRepository } from '@/modules/writing/chart-uploads/infrastructure/postgres-writing-chart-revocation-audit.repository';
import type { PostgresWritingChartUploadRepository } from '@/modules/writing/chart-uploads/infrastructure/postgres-writing-chart-upload.repository';

import { operatorPostgresApplicationName } from './operator-postgres-application-name';

export async function createOperatorWritingChartClient(
  databaseUrl: string,
): Promise<PostgresWritingChartUploadRepository & { close(): Promise<void> }> {
  const [prismaModule, repositoryModule] = await Promise.all([
    import('@/modules/persistence/infrastructure/prisma-client'),
    import(
      '@/modules/writing/chart-uploads/infrastructure/postgres-writing-chart-upload.repository'
    ),
  ]);
  const holder = prismaModule.createOperatorPrismaClient(
    'runtime',
    databaseUrl,
    operatorPostgresApplicationName('runtime'),
  );
  return Object.assign(
    new repositoryModule.PostgresWritingChartUploadRepository(holder.prisma),
    { close: () => holder.close() },
  );
}

export async function createOperatorWritingChartRevocationAuditClient(
  databaseUrl: string,
): Promise<
  PostgresWritingChartRevocationAuditRepository & { close(): Promise<void> }
> {
  const [{ createOperatorPrismaClient }, repositoryModule] = await Promise.all([
    import('@/modules/persistence/infrastructure/prisma-client'),
    import(
      '@/modules/writing/chart-uploads/infrastructure/postgres-writing-chart-revocation-audit.repository'
    ),
  ]);
  const holder = createOperatorPrismaClient(
    'runtime',
    databaseUrl,
    operatorPostgresApplicationName('runtime'),
  );
  return Object.assign(
    new repositoryModule.PostgresWritingChartRevocationAuditRepository(
      holder.prisma,
    ),
    { close: () => holder.close() },
  );
}
