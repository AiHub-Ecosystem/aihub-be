import { Logger } from '@nestjs/common';
import { Pool, type PoolClient, type TransactionStatus } from 'pg';

import { getMetrics } from '@/common/observability/metrics/metrics';
import {
  POSTGRES_ACQUISITION_TIMEOUT_MS,
  POSTGRES_CONNECT_TIMEOUT_MS,
  createPostgresPool,
  postgresPoolOptions,
} from './postgres-pool';

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

describe('Postgres pool options', () => {
  it('keeps one connection past the idle timeout so a sparse caller stays warm', () => {
    const options = postgresPoolOptions('postgres://runtime', 44);

    // A caller spaced wider than idleTimeoutMillis (the 60 s Sandbox probe)
    // finds a warm connection instead of paying a cold handshake.
    expect(options.min).toBe(1);
    expect(options.idleTimeoutMillis).toBe(30_000);
  });

  it('gives a connection establishment its own budget, not the queue budget', () => {
    const options = postgresPoolOptions('postgres://runtime', 44);

    // `connectionTimeoutMillis` bounds pg-pool's own socket, i.e. the
    // handshake. Sharing 250 ms with the slot queue cut healthy connections
    // and answered a database outage (ADR-0088).
    expect(options.connectionTimeoutMillis).toBe(POSTGRES_CONNECT_TIMEOUT_MS);
    expect(options.connectionTimeoutMillis).toBeGreaterThan(
      POSTGRES_ACQUISITION_TIMEOUT_MS,
    );
  });
});

describe('Postgres pool connect budget', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not cut an opening connection at the queue deadline', async () => {
    jest.useFakeTimers();
    const connect = jest.spyOn(Pool.prototype, 'connect');
    const callbacks: ConnectCallback[] = [];
    connect.mockImplementation(((callback: ConnectCallback) => {
      callbacks.push(callback);
    }) as never);
    const pool = createPostgresPool('integration-test', { max: 1 });

    const pending = pool.connect();
    // A cold TCP, TLS, and authentication handshake outlasts the 250 ms a
    // queued request may wait, and truncating it is what answered
    // 503 DATABASE_UNAVAILABLE while PostgreSQL was healthy.
    jest.advanceTimersByTime(400);

    const release = jest.fn<undefined, [Error | boolean | undefined]>();
    const client = {
      getTransactionStatus: () => 'I',
      release,
    } as unknown as PoolClient;
    callbacks[0]?.(undefined, client, (error) => client.release(error));

    const borrowedClient = await pending;
    borrowedClient.release();

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

    // One hundred concurrent requests against a dead database: five hold
    // slots and retry inside their acquisition budget, ninety-five wait, and
    // every failure feeds the breaker until it opens.
    await Promise.all(
      Array.from({ length: 100 }, () =>
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

describe('Postgres pool retry ceiling (#2023)', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED'), {
    code: 'ECONNREFUSED',
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Lets the promise reactions of a settled checkout run. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
  }

  /** Records the connect timeout pg-pool would apply to each attempt. */
  function recordAttempts() {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const timeouts: (number | undefined)[] = [];
    const callbacks: ConnectCallback[] = [];
    jest.spyOn(Pool.prototype, 'connect').mockImplementation(function (
      this: Pool,
      callback: ConnectCallback,
    ) {
      timeouts.push(this.options.connectionTimeoutMillis);
      callbacks.push(callback);
    } as never);
    const pool = createPostgresPool('integration-test', {
      max: 1,
      connectionTimeoutMillis: POSTGRES_CONNECT_TIMEOUT_MS,
    });
    return { pool, timeouts, callbacks };
  }

  it('caps a retry handshake at one second from the request, not 3 s from the retry', () => {
    // 0.999 draws the longest first delay: 30 ms.
    jest.spyOn(Math, 'random').mockReturnValue(0.999);
    const { pool, timeouts, callbacks } = recordAttempts();

    void pool.connect().catch(() => undefined);
    expect(timeouts).toEqual([3_000]);

    // The first attempt fails at 215 ms; its 30 ms delay lands the retry at
    // 245 ms, just inside the 250 ms mark that gates a retry.
    jest.advanceTimersByTime(215);
    callbacks[0]?.(refused, undefined, () => undefined);
    jest.advanceTimersByTime(30);

    expect(timeouts).toEqual([3_000, 755]);
    // The cap applies to that attempt only.
    expect(pool.options.connectionTimeoutMillis).toBe(3_000);
  });

  /** Fails three attempts quickly, then leaves the fourth, at 220 ms, hanging. */
  async function stallRetryChain() {
    // 0.999 draws the longest delays: 30, 90, then 100 ms.
    jest.spyOn(Math, 'random').mockReturnValue(0.999);
    const attempts = recordAttempts();
    const { pool, timeouts, callbacks } = attempts;
    let outcome: unknown = 'pending';
    void pool
      .connect()
      .then(
        () => 'resolved',
        (error: unknown) => error,
      )
      .then((settled) => {
        outcome = settled;
        return settled;
      });
    const fail = () => callbacks.at(-1)?.(refused, undefined, () => undefined);
    fail();
    jest.advanceTimersByTime(30);
    fail();
    jest.advanceTimersByTime(90);
    fail();
    jest.advanceTimersByTime(100);
    expect(timeouts).toEqual([3_000, 970, 880, 780]);
    await settle();
    return { ...attempts, outcome: () => outcome };
  }

  it('rejects a stalled retry chain at the ceiling and frees the slot', async () => {
    const { pool, callbacks, outcome } = await stallRetryChain();

    // 220 ms in; the hanging retry has until 1000 ms, not 3.22 s.
    jest.advanceTimersByTime(779);
    await settle();
    expect(outcome()).toBe('pending');

    jest.advanceTimersByTime(1);
    await settle();
    expect(outcome()).toMatchObject({ code: 'P2024' });

    // pg-pool's own timer destroys the connecting socket at the same instant.
    const attemptsBefore = callbacks.length;
    callbacks.at(-1)?.(
      new Error('Connection terminated due to connection timeout'),
      undefined,
      () => undefined,
    );
    void pool.connect().catch(() => undefined);
    expect(callbacks).toHaveLength(attemptsBefore + 1);
  });

  it('destroys a connection that opens after its request expired', async () => {
    const { pool, callbacks } = await stallRetryChain();
    jest.advanceTimersByTime(780);
    await settle();

    const done = jest.fn();
    callbacks.at(-1)?.(undefined, {} as PoolClient, done);

    expect(done).toHaveBeenCalledWith(true);
    const attemptsBefore = callbacks.length;
    void pool.connect().catch(() => undefined);
    expect(callbacks).toHaveLength(attemptsBefore + 1);
  });
});
