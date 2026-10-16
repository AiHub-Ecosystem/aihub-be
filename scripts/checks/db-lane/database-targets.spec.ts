import { databaseUrlsForLane } from './database-targets';

describe('database URLs for validation lanes', () => {
  it('does not create the unused sandbox database for tenant isolation', () => {
    expect(
      databaseUrlsForLane(
        'aihub_tenant_isolation_lane',
        'postgres://localhost/aihub_tenant_isolation_lane',
        'postgres://localhost/aihub_sandbox_db_lane',
      ),
    ).toEqual(['postgres://localhost/aihub_tenant_isolation_lane']);
  });

  it('keeps both databases for the full database lane', () => {
    expect(
      databaseUrlsForLane(
        'aihub_db_lane',
        'postgres://localhost/aihub_db_lane',
        'postgres://localhost/aihub_sandbox_db_lane',
      ),
    ).toEqual([
      'postgres://localhost/aihub_db_lane',
      'postgres://localhost/aihub_sandbox_db_lane',
    ]);
  });

  it('keeps the crash worker from dropping its parent lane databases', () => {
    const workerConfig = require('../../../jest.config.db-worker.cjs') as {
      globalSetup?: string;
      globalTeardown?: string;
    };

    expect(workerConfig.globalSetup).toBeUndefined();
    expect(workerConfig.globalTeardown).toBeUndefined();
  });
});
