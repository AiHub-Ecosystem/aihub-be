export async function createOperatorWritingChartClient(databaseUrl: string) {
  const [prismaModule, repositoryModule] = await Promise.all([
    import('@/modules/persistence/infrastructure/prisma-client'),
    import(
      '@/modules/writing/infrastructure/postgres-writing-chart-upload.repository'
    ),
  ]);
  const holder = prismaModule.createOperatorPrismaClient(
    'runtime',
    databaseUrl,
  );
  return Object.assign(
    new repositoryModule.PostgresWritingChartUploadRepository(holder.prisma),
    { close: () => holder.close() },
  );
}

export async function createOperatorWritingChartRevocationAuditClient(
  databaseUrl: string,
) {
  const [{ createOperatorPrismaClient }, repositoryModule] = await Promise.all([
    import('@/modules/persistence/infrastructure/prisma-client'),
    import(
      '@/modules/writing/infrastructure/postgres-writing-chart-revocation-audit.repository'
    ),
  ]);
  const holder = createOperatorPrismaClient('runtime', databaseUrl);
  return Object.assign(
    new repositoryModule.PostgresWritingChartRevocationAuditRepository(
      holder.prisma,
    ),
    { close: () => holder.close() },
  );
}
