export function databaseUrlsForLane(
  databaseName: string,
  testDatabaseUrl: string,
  sandboxDatabaseUrl: string,
): string[] {
  return databaseName === 'aihub_tenant_isolation_lane'
    ? [testDatabaseUrl]
    : [testDatabaseUrl, sandboxDatabaseUrl];
}
