import { Logger } from '@nestjs/common';
import { Pool, type PoolClient, type TransactionStatus } from 'pg';

import { getMetrics } from '@/common/observability/metrics';
import { createPostgresPool } from './postgres-pool';

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: Error | boolean) => void,
) => void;

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
    connect.mockImplementation(((callback: ConnectCallback) => {
      callback(undefined, client, (error) => client.release(error));
    }) as never);
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
      expect(warn).toHaveBeenCalledWith({
        event: 'postgres_connection_discarded',
        pool: 'integration-test',
        transaction_status: status ?? 'unknown',
      });
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

  it('expires a queued checkout without borrowing a connection later', async () => {
    const callbacks: ConnectCallback[] = [];
    const connect = jest.spyOn(Pool.prototype, 'connect');
    connect.mockImplementation(((callback: ConnectCallback) => {
      callbacks.push(callback);
    }) as never);
    const pool = createPostgresPool('integration-test', { max: 1 });
    const first = pool.connect();
    const second = pool.connect();
    const release = jest.fn<undefined, [Error | boolean | undefined]>();
    const client = {
      getTransactionStatus: () => 'I',
      release,
    } as unknown as PoolClient;
    callbacks[0]?.(undefined, client, (error) => client.release(error));
    const borrowedClient = await first;

    expect(pool.waitingCount).toBe(1);
    await expect(second).rejects.toMatchObject({ code: 'P2024' });
    expect(pool.waitingCount).toBe(0);
    borrowedClient.release();

    expect(callbacks).toHaveLength(1);
    expect(release).toHaveBeenCalledWith();
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

describe('Postgres pool reconnect backoff (#1608)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retries a failed attempt with a jittered delay and succeeds', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const connect = jest.spyOn(Pool.prototype, 'connect');
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    let calls = 0;
    connect.mockImplementation(((callback: ConnectCallback) => {
      calls += 1;
      if (calls === 1) {
        callback(refused, undefined, () => undefined);
        return;
      }
      const client = {
        getTransactionStatus: () => 'I',
        release: jest.fn(),
      } as unknown as PoolClient;
      callback(undefined, client, (error) => client.release(error));
    }) as never);
    const pool = createPostgresPool('integration-test', { max: 1 });

    const client = await pool.connect();
    client.release();

    expect(calls).toBe(2);
    const payload = await getMetrics();
    expect(payload).toContain(
      'aihub_postgres_pool_backoff_delay_seconds_count{pool="integration-test"} 1',
    );
    expect(payload).toContain(
      'aihub_postgres_pool_connect_retry_latency_seconds_count{pool="integration-test",outcome="success"} 1',
    );
  });

  it('does not retry an error the server would repeat', async () => {
    const connect = jest.spyOn(Pool.prototype, 'connect');
    const badPassword = Object.assign(
      new Error('password authentication failed'),
      {
        code: '28P01',
      },
    );
    connect.mockImplementation(((callback: ConnectCallback) => {
      callback(badPassword, undefined, () => undefined);
    }) as never);
    const pool = createPostgresPool('integration-test', { max: 1 });

    await expect(pool.connect()).rejects.toBe(badPassword);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('opens the starvation breaker and sheds instead of queueing', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const connect = jest.spyOn(Pool.prototype, 'connect');
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    connect.mockImplementation(((callback: ConnectCallback) => {
      callback(refused, undefined, () => undefined);
    }) as never);
    const pool = createPostgresPool('integration-test', { max: 5 });

    // Ten concurrent requests against a dead database: five hold slots and
    // retry inside their acquisition budget, five wait, and every failure
    // feeds the breaker until it opens.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        expect(pool.connect()).rejects.toBeInstanceOf(Error),
      ),
    );
    expect(pool.waitingCount).toBe(0);
    expect(pool.totalCount).toBe(0);
    const payloadBeforeShed = await getMetrics();
    const shedPrefix =
      'aihub_postgres_pool_shed_total{pool="integration-test"} ';
    const shedBefore = Number(
      payloadBeforeShed
        .split('\n')
        .find((line) => line.startsWith(shedPrefix))
        ?.split(' ')
        .at(-1) ?? 0,
    );

    // While open: refused at once, without another attempt.
    const before = Date.now();
    await expect(pool.connect()).rejects.toMatchObject({ code: 'P2024' });
    expect(Date.now() - before).toBeLessThan(50);

    const payload = await getMetrics();
    const shedAfter = Number(
      payload
        .split('\n')
        .find((line) => line.startsWith(shedPrefix))
        ?.split(' ')
        .at(-1) ?? 0,
    );
    expect(shedAfter).toBe(shedBefore + 1);
    expect(payload).toContain(
      'aihub_postgres_pool_breaker_transitions_total{pool="integration-test",state="open"} 1',
    );
  });
});
