import {
  aggregatePgbouncerRows,
  createExporter,
  databaseAliases,
} from '../../../scripts/ops/monitoring/pgbouncer-exporter.mjs';

const ALIASES = ['aihub_be', 'ai_writing', 'ai_speaking', 'ai_portal'];

describe('PgBouncer metrics exporter', () => {
  it('reads only logical database aliases from the PgBouncer config', () => {
    const config = `[databases]\n${ALIASES.map((alias) => `${alias} = host=db`).join('\n')}\n[pgbouncer]\nlisten_port = 5432`;

    expect(databaseAliases(config)).toEqual(ALIASES);
  });

  it('aggregates client, backend, and queue state without username labels', () => {
    const samples = aggregatePgbouncerRows(
      [
        { database: 'aihub_be', state: 'idle', user: 'secret-user' },
        {
          database: 'aihub_be',
          state: 'waiting_cancel_req',
          user: 'secret-user',
        },
        { database: 'pgbouncer', state: 'active', user: 'metrics-user' },
      ],
      [
        {
          database: 'aihub_be',
          sv_active: '1',
          sv_idle: '2',
          sv_used: '0',
          sv_tested: '0',
          sv_login: '0',
          cl_waiting: '1',
          maxwait: '0.25',
        },
      ],
      ALIASES,
    );

    expect(samples.clients).toContainEqual({
      database: 'aihub_be',
      state: 'idle',
      count: 1,
    });
    expect(samples.clients).toContainEqual({
      database: 'aihub_be',
      state: 'waiting',
      count: 1,
    });
    expect(samples.backends).toContainEqual({
      database: 'aihub_be',
      state: 'active',
      count: 1,
    });
    expect(samples.waiting).toContainEqual({ database: 'aihub_be', count: 1 });
    expect(samples.maxWait).toContainEqual({
      database: 'aihub_be',
      seconds: 0.25,
    });
    expect(JSON.stringify(samples)).not.toContain('secret-user');
  });

  it('returns 503 when the PgBouncer admin scrape fails', async () => {
    const exporter = createExporter(
      {
        query: async () => {
          throw new Error('connection closed');
        },
      } as never,
      ALIASES,
    );
    const port = await new Promise<number>((resolve) => {
      exporter.server.listen(0, '127.0.0.1', () => {
        const address = exporter.server.address();
        if (address && typeof address !== 'string') resolve(address.port);
      });
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('');
    } finally {
      await new Promise<void>((resolve, reject) => {
        exporter.server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });
});
