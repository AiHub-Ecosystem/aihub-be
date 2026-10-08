import { Pool, type PoolClient } from 'pg';

import {
  type PostgresIdentityQueryClient,
  createPostgresIdentityClient,
} from './postgres-identity.client';

afterEach(() => {
  jest.restoreAllMocks();
});

function identityClient(
  query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>,
) {
  const driverQuery = jest.fn(query);
  const release = jest.fn();
  const connectedClient = {
    query: driverQuery,
    release,
  } as unknown as PoolClient;
  jest
    .spyOn(Pool.prototype, 'connect')
    .mockImplementation(() => Promise.resolve(connectedClient) as never);

  return {
    client: createPostgresIdentityClient('postgres://identity.test/control'),
    driverQuery,
    release,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('createPostgresIdentityClient transaction lifetime', () => {
  it('allows queries during the callback and rejects later use before PostgreSQL', async () => {
    const { client, driverQuery, release } = identityClient(async (text) => ({
      rows: text === 'SELECT value' ? [{ value: 42 }] : [],
    }));

    const expiredHandle = await client.transaction(async (transaction) => {
      await expect(transaction.query('SELECT value', [])).resolves.toEqual([
        { value: 42 },
      ]);
      return transaction;
    });

    const callsAtCallbackEnd = driverQuery.mock.calls.length;
    await expect(expiredHandle.query('SELECT late', [])).rejects.toMatchObject({
      name: 'PostgresIdentityTransactionExpiredError',
      message: 'Identity transaction is no longer active',
    });

    expect(driverQuery).toHaveBeenCalledTimes(callsAtCallbackEnd);
    expect(driverQuery.mock.calls.map(([text]) => text)).toEqual([
      'BEGIN',
      'SELECT value',
      'COMMIT',
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('waits for queries started in the callback before committing', async () => {
    const queryStarted = deferred<void>();
    const queryResult = deferred<{
      readonly rows: readonly Record<string, unknown>[];
    }>();
    const { client, driverQuery, release } = identityClient(async (text) => {
      if (text === 'SELECT pending') {
        queryStarted.resolve();
        return queryResult.promise;
      }
      return { rows: [] };
    });

    const transaction = client.transaction(async (handle) => {
      void handle.query('SELECT pending', []);
    });
    await queryStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(driverQuery.mock.calls.map(([text]) => text)).toEqual([
      'BEGIN',
      'SELECT pending',
    ]);
    expect(release).not.toHaveBeenCalled();

    queryResult.resolve({ rows: [] });
    await expect(transaction).resolves.toBeUndefined();
    expect(driverQuery.mock.calls.map(([text]) => text)).toEqual([
      'BEGIN',
      'SELECT pending',
      'COMMIT',
    ]);
  });

  it('rolls back when a callback leaves a failed query unawaited', async () => {
    const queryError = new Error('query failed');
    const { client, driverQuery } = identityClient(async (text) => {
      if (text === 'SELECT forgotten') {
        throw queryError;
      }
      return { rows: [] };
    });

    await expect(
      client.transaction(async (handle) => {
        void handle.query('SELECT forgotten', []);
      }),
    ).rejects.toBe(queryError);

    expect(driverQuery.mock.calls.map(([text]) => text)).toEqual([
      'BEGIN',
      'SELECT forgotten',
      'ROLLBACK',
    ]);
  });

  it('drains in-flight queries before rollback and preserves the callback error', async () => {
    const callbackError = new Error('callback failed');
    const queryStarted = deferred<void>();
    const queryResult = deferred<{
      readonly rows: readonly Record<string, unknown>[];
    }>();
    const { client, driverQuery, release } = identityClient(async (text) => {
      if (text === 'SELECT pending') {
        queryStarted.resolve();
        return queryResult.promise;
      }
      return { rows: [] };
    });
    let expiredHandle: PostgresIdentityQueryClient | undefined;

    const transaction = client.transaction(async (handle) => {
      expiredHandle = handle;
      void handle.query('SELECT pending', []);
      throw callbackError;
    });
    await queryStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(driverQuery.mock.calls.map(([text]) => text)).toEqual([
      'BEGIN',
      'SELECT pending',
    ]);
    expect(release).not.toHaveBeenCalled();

    queryResult.reject(new Error('pending query failed'));
    await expect(transaction).rejects.toBe(callbackError);

    expect(driverQuery.mock.calls.map(([text]) => text)).toEqual([
      'BEGIN',
      'SELECT pending',
      'ROLLBACK',
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    if (expiredHandle === undefined) {
      throw new Error('The callback did not receive a transaction handle');
    }
    const callsAtCallbackEnd = driverQuery.mock.calls.length;
    await expect(expiredHandle.query('SELECT late', [])).rejects.toMatchObject({
      name: 'PostgresIdentityTransactionExpiredError',
      message: 'Identity transaction is no longer active',
    });
    expect(driverQuery).toHaveBeenCalledTimes(callsAtCallbackEnd);
  });
});
