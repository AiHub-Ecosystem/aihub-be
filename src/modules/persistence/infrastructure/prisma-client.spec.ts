import { createSharedPrismaClients } from './prisma-client';

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

  it('carries the pool settings every control-plane pool already used', async () => {
    const clients = createSharedPrismaClients({
      databaseUrl: equal,
      controlPlaneDatabaseUrl: equal,
      controlPlaneReadDatabaseUrl: equal,
    });

    const pool = clients.runtime.pool;
    expect(pool.options.max).toBe(10);
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

    expect(() => clients.runtime.prisma).toThrow(
      'PostgreSQL is not configured',
    );
    await expect(clients.controlPlaneRead.checkConnection(750)).rejects.toThrow(
      'PostgreSQL is not configured',
    );

    await clients.close();
  });
});
