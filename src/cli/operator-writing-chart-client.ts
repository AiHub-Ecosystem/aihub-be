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
