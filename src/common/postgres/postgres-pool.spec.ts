import { Logger } from '@nestjs/common';
import { Pool, type PoolClient, type TransactionStatus } from 'pg';

import { getMetrics } from '@/common/observability/metrics';
import { createPostgresPool } from './postgres-pool';

describe('Postgres pool connection reuse', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function borrowed(status: TransactionStatus) {
    const release = jest.fn<undefined, [Error | boolean | undefined]>();
    const client = {
      getTransactionStatus: () => status,
      release,
    } as unknown as PoolClient;
    const connect = jest.spyOn(Pool.prototype, 'connect');
    connect.mockResolvedValue(client as never);
    return { release, client, connect };
  }

  it('returns an idle connection to the pool', async () => {
    const { release } = borrowed('I');
    const pool = createPostgresPool('integration-test', { max: 1 });

    (await pool.connect()).release();

    expect(release).toHaveBeenCalledWith();
  });

  it.each<TransactionStatus>(['T', 'E', null])(
    'destroys a connection released with transaction status %s and reports only the status',
    async (status) => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const { release } = borrowed(status);
      const pool = createPostgresPool('integration-test', { max: 1 });

      (await pool.connect()).release();

      expect(release).toHaveBeenCalledWith(expect.any(Error));
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          event: 'postgres_connection_discarded',
          pool: 'integration-test',
          transaction_status: status ?? 'unknown',
        }),
      );
    },
  );

  it('guards a connection borrowed through the callback form pg-pool query uses', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { release, client, connect } = borrowed('T');
    connect.mockImplementation(((
      callback: (
        error: Error | undefined,
        borrowedClient: PoolClient,
        done: (error?: Error | boolean) => void,
      ) => void,
    ): void => {
      callback(undefined, client, (error) => {
        client.release(error);
      });
    }) as never);
    const pool = createPostgresPool('integration-test', { max: 1 });

    const done = await new Promise<(error?: Error | boolean) => void>(
      (resolve) => {
        pool.connect((_error, _client, releaseClient) => {
          resolve(releaseClient);
        });
      },
    );
    done();

    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it('keeps the error a caller releases with', async () => {
    const { release } = borrowed('I');
    const pool = createPostgresPool('integration-test', { max: 1 });
    const failure = new Error('connection terminated');

    (await pool.connect()).release(failure);

    expect(release).toHaveBeenCalledWith(failure);
  });
});

describe('Postgres pool metrics', () => {
  it('scrapes live counts under the factory pool name', async () => {
    const pool = createPostgresPool('integration-test', { max: 2 });

    try {
      const payload = await getMetrics();

      expect(payload).toContain(
        'aihub_postgres_pool_total{pool="integration-test"} 0',
      );
      expect(payload).toContain(
        'aihub_postgres_pool_idle{pool="integration-test"} 0',
      );
      expect(payload).toContain(
        'aihub_postgres_pool_waiting{pool="integration-test"} 0',
      );
    } finally {
      await pool.end();
    }
  });
});
