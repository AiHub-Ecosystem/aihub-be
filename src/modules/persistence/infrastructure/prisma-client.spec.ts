import { createPrismaClient, createSharedPrismaClients } from './prisma-client';

describe('createSharedPrismaClients', () => {
  const equal = 'postgres://shared';
  const distinct = 'postgres://distinct';

  it('opens one client when every role names the same database', async () => {
    const clients = createSharedPrismaClients({
      databaseUrl: equal,
      controlPlaneDatabaseUrl: equal,
      controlPlaneReadDatabaseUrl: equal,
    });

    expect(clients.runtime).toBe(clients.controlPlane);
    expect(clients.controlPlane).toBe(clients.controlPlaneRead);

    await clients.close();
  });

  it('opens one client per distinct database when the roles differ', async () => {
    const clients = createSharedPrismaClients({
      databaseUrl: distinct,
      controlPlaneDatabaseUrl: equal,
      controlPlaneReadDatabaseUrl: equal,
    });

    expect(clients.runtime).not.toBe(clients.controlPlane);
    expect(clients.controlPlane).toBe(clients.controlPlaneRead);

    await clients.close();
  });

  it('keeps each role its own share of a pool the roles have in common', async () => {
    const shared = createSharedPrismaClients({
      databaseUrl: equal,
      controlPlaneDatabaseUrl: equal,
      controlPlaneReadDatabaseUrl: equal,
    });
    const split = createSharedPrismaClients({
      databaseUrl: distinct,
      controlPlaneDatabaseUrl: equal,
      controlPlaneReadDatabaseUrl: equal,
    });

    // runtime 44 + control-plane 20 + control-plane-read 10
    expect(shared.runtime.pool.options.max).toBe(74);
    expect(split.runtime.pool.options.max).toBe(44);
    expect(split.controlPlane.pool.options.max).toBe(30);

    await shared.close();
    await split.close();
  });

  it('carries the connection and idle timeouts every control-plane pool already used', async () => {
    const clients = createSharedPrismaClients({
      databaseUrl: equal,
      controlPlaneDatabaseUrl: equal,
      controlPlaneReadDatabaseUrl: equal,
    });

    const pool = clients.runtime.pool;
    expect(pool.options.connectionTimeoutMillis).toBe(1_000);
    expect(pool.options.idleTimeoutMillis).toBe(30_000);

    await clients.close();
  });

  it('checks the shared pool with the supplied timeout', async () => {
    const clients = createSharedPrismaClients({
      databaseUrl: equal,
      controlPlaneDatabaseUrl: equal,
      controlPlaneReadDatabaseUrl: equal,
    });

    const query = jest
      .spyOn(clients.runtime.pool, 'query')
      .mockResolvedValue(undefined as never);

    await clients.runtime.checkConnection(750);

    expect(query).toHaveBeenCalledWith({
      text: 'SELECT 1',
      query_timeout: 750,
    });

    await clients.close();
  });

  it('builds no pool for a role without a URL, and fails on first use', async () => {
    const clients = createSharedPrismaClients({
      databaseUrl: undefined,
      controlPlaneDatabaseUrl: equal,
      controlPlaneReadDatabaseUrl: undefined,
    });

    // Handing the client out must not throw: the module graph still builds.
    expect(clients.runtime.prisma).toBeDefined();
    // Nor must the optional `close` probe a repository makes on shutdown.
    expect(Reflect.get(clients.runtime.prisma, 'close')).toBeUndefined();
    expect('close' in clients.runtime.prisma).toBe(false);
    expect('onApplicationShutdown' in clients.runtime.prisma).toBe(false);
    expect(() => clients.runtime.prisma.$queryRawUnsafe('SELECT 1')).toThrow(
      'PostgreSQL is not configured',
    );
    await expect(clients.controlPlaneRead.checkConnection(750)).rejects.toThrow(
      'PostgreSQL is not configured',
    );

    await clients.close();
  });
});

describe('createPrismaClient', () => {
  it('does not create a pool for a blank database URL', async () => {
    const client = createPrismaClient('control-plane', '');

    try {
      expect(() => client.pool).toThrow('PostgreSQL is not configured');
    } finally {
      await client.close();
    }
  });
});
