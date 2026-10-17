import {
  flushOwnedRedisDatabase,
  withOwnedPostgresDatabase,
  withOwnedPostgresServer,
} from './ownership';

describe('database lane ownership guards', () => {
  it('refuses PostgreSQL lifecycle work before the server ownership marker is verified', async () => {
    const verifyOwnership = jest.fn().mockResolvedValue(false);
    const destructiveSetup = jest.fn().mockResolvedValue(undefined);

    await expect(
      withOwnedPostgresServer(verifyOwnership, destructiveSetup),
    ).rejects.toThrow('DB_LANE_ADMIN_URL');

    expect(verifyOwnership).toHaveBeenCalledTimes(1);
    expect(destructiveSetup).not.toHaveBeenCalled();
  });

  it('allows PostgreSQL lifecycle work after the server ownership marker is verified', async () => {
    const setup = jest.fn().mockResolvedValue('ready');

    await expect(
      withOwnedPostgresServer(async () => true, setup),
    ).resolves.toBe('ready');

    expect(setup).toHaveBeenCalledTimes(1);
  });

  it('checks the ownership marker on the configured admin database', async () => {
    const admin = {
      query: jest.fn().mockResolvedValue({ rows: [{ owned: true }] }),
    };
    const setup = jest.fn().mockResolvedValue(undefined);

    await withOwnedPostgresDatabase(admin, 'postgres', setup);

    expect(admin.query).toHaveBeenCalledWith(
      expect.stringContaining('db.datname = $1'),
      ['postgres', 'aihub.test_lane_marker=aihub_db_lane_v1'],
    );
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it('refuses Redis FLUSHDB when its ownership marker is missing', async () => {
    const owner = {
      get: jest.fn().mockResolvedValue(null),
      on: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const flush = jest.fn().mockResolvedValue('OK');

    await expect(
      flushOwnedRedisDatabase(owner, flush, 'SANDBOX_TEST_REDIS_URL'),
    ).rejects.toThrow('SANDBOX_TEST_REDIS_URL');

    expect(flush).not.toHaveBeenCalled();
    expect(owner.quit).toHaveBeenCalledTimes(1);
  });

  it('flushes Redis only after its ownership marker is verified', async () => {
    const owner = {
      get: jest.fn().mockResolvedValue('aihub-db-lane-v1'),
      on: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const flush = jest.fn().mockResolvedValue('OK');

    await expect(
      flushOwnedRedisDatabase(owner, flush, 'TENANT_ISOLATION_REDIS_URL'),
    ).resolves.toBeUndefined();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(owner.quit).toHaveBeenCalledTimes(1);
  });
});
