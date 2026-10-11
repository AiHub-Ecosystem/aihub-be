import { Buffer } from 'node:buffer';

import { Prisma, PrismaClient } from '@prisma-client/client';

import { createIdentityTransactionRunner } from './postgres-identity.client';

afterEach(() => {
  jest.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function identityClient(
  query: (...args: unknown[]) => Promise<readonly Record<string, unknown>[]>,
  execute: (...args: unknown[]) => Promise<number> = async () => 0,
) {
  const queryRaw = jest.fn(query);
  const executeRaw = jest.fn(execute);
  let outcome: 'committed' | 'rolled back' | undefined;
  const transaction = jest.fn(
    async (
      callback: (client: Prisma.TransactionClient) => Promise<unknown>,
      _options?: { readonly maxWait?: number; readonly timeout?: number },
    ) => {
      try {
        const result = await callback({
          $queryRawUnsafe: queryRaw,
          $executeRawUnsafe: executeRaw,
        } as unknown as Prisma.TransactionClient);
        outcome = 'committed';
        return result;
      } catch (error) {
        outcome = 'rolled back';
        throw error;
      }
    },
  );
  const prisma = {
    $queryRawUnsafe: queryRaw,
    $executeRawUnsafe: executeRaw,
    $transaction: transaction,
  } as unknown as PrismaClient;

  return {
    client: createIdentityTransactionRunner(() => prisma),
    queryRaw,
    executeRaw,
    transaction,
    outcome: () => outcome,
  };
}

describe('Identity transaction lifetime on Prisma', () => {
  it('rejects an expired handle before the driver receives another query', async () => {
    const { client, queryRaw, transaction } = identityClient(async () => [
      { value: 42 },
    ]);

    const expiredHandle = await client.transaction(async (handle) => {
      await expect(handle.query('SELECT value', [])).resolves.toEqual([
        { value: 42 },
      ]);
      return handle;
    });

    const callsAtCallbackEnd = queryRaw.mock.calls.length;
    await expect(expiredHandle.query('SELECT late', [])).rejects.toMatchObject({
      name: 'PostgresIdentityTransactionExpiredError',
      message: 'Identity transaction is no longer active',
    });

    expect(queryRaw).toHaveBeenCalledTimes(callsAtCallbackEnd);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 1_000,
      timeout: 5_000,
    });
  });

  it('drains in-flight calls before Prisma can commit', async () => {
    const queryStarted = deferred<void>();
    const queryResult = deferred<readonly Record<string, unknown>[]>();
    const { client, outcome } = identityClient(async () => {
      queryStarted.resolve();
      return queryResult.promise;
    });

    const transaction = client.transaction(async (handle) => {
      void handle.query('SELECT pending', []);
    });
    await queryStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(outcome()).toBeUndefined();

    queryResult.resolve([]);
    await expect(transaction).resolves.toBeUndefined();
    expect(outcome()).toBe('committed');
  });

  it('drains pending calls before rollback and keeps the callback error primary', async () => {
    const callbackError = new Error('callback failed');
    const queryStarted = deferred<void>();
    const queryResult = deferred<readonly Record<string, unknown>[]>();
    const { client, outcome } = identityClient(async () => {
      queryStarted.resolve();
      return queryResult.promise;
    });

    const transaction = client.transaction(async (handle) => {
      void handle.query('SELECT pending', []);
      throw callbackError;
    });
    await queryStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(outcome()).toBeUndefined();

    queryResult.reject(new Error('pending query failed'));
    await expect(transaction).rejects.toBe(callbackError);
    expect(outcome()).toBe('rolled back');
  });

  it('rolls back when a callback leaves a failed query unawaited', async () => {
    const queryError = new Error('query failed');
    const { client, outcome } = identityClient(async () => {
      throw queryError;
    });

    await expect(
      client.transaction(async (handle) => {
        void handle.query('SELECT forgotten', []);
      }),
    ).rejects.toBe(queryError);
    expect(outcome()).toBe('rolled back');
  });

  it('executes a no-result write on the caller transaction', async () => {
    const { client, queryRaw, executeRaw, outcome } = identityClient(
      async () => [],
    );

    await expect(
      client.transaction((handle) =>
        handle.query('INSERT INTO email_delivery_requests (id) VALUES ($1)', [
          'edr_01J00000000000000000000000',
        ]),
      ),
    ).resolves.toEqual([]);

    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(outcome()).toBe('committed');
  });

  it('maps raw values back to the PostgreSQL client types', async () => {
    const createdAt = new Date('2026-10-11T00:00:00.000Z');
    const bytes = new Uint8Array([1, 2, 3]);
    const { client } = identityClient(async () => [
      {
        largeNumber: 9_007_199_254_740_993n,
        preciseNumber: new Prisma.Decimal('12.3400'),
        binary: bytes,
        createdAt,
      },
    ]);

    const rows = await client.query('SELECT mapped values', []);

    expect(rows).toEqual([
      {
        largeNumber: '9007199254740993',
        preciseNumber: '12.34',
        binary: Buffer.from(bytes),
        createdAt,
      },
    ]);
    const firstRow = rows[0];
    if (typeof firstRow !== 'object' || firstRow === null) {
      throw new Error('The raw query returned no row');
    }
    expect(Buffer.isBuffer(Reflect.get(firstRow, 'binary'))).toBe(true);
  });
});
