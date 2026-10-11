import { Buffer } from 'node:buffer';

import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import { Prisma, PrismaClient } from '@prisma-client/client';
import { createAuthTransactionRunner } from './postgres-auth.client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function authClient(
  query: (...args: unknown[]) => Promise<readonly Record<string, unknown>[]>,
) {
  const queryRaw = jest.fn(query);
  const executeRaw = jest.fn(async () => 1);
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
    client: createAuthTransactionRunner(() => prisma),
    queryRaw,
    executeRaw,
    transaction,
    outcome: () => outcome,
  };
}

describe('Auth transaction lifetime on Prisma', () => {
  it('rejects an expired handle before the driver receives another query', async () => {
    const { client, queryRaw, transaction } = authClient(async () => [
      { value: 42 },
    ]);

    const expiredHandle = await client.transaction(async (handle) => {
      await expect(handle.query('SELECT value', [])).resolves.toEqual([
        { value: 42 },
      ]);
      return handle;
    });

    const callsAtCallbackEnd = queryRaw.mock.calls.length;
    await expect(expiredHandle.query('SELECT late', [])).rejects.toThrow(
      'Auth transaction is no longer active',
    );

    expect(queryRaw).toHaveBeenCalledTimes(callsAtCallbackEnd);
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      CONTROL_PLANE_TRANSACTION_OPTIONS,
    );
  });

  it('drains in-flight calls before Prisma can commit', async () => {
    const queryStarted = deferred<void>();
    const queryResult = deferred<readonly Record<string, unknown>[]>();
    const { client, outcome } = authClient(async () => {
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

  it('keeps the callback error primary while pending calls drain before rollback', async () => {
    const callbackError = new Error('callback failed');
    const queryStarted = deferred<void>();
    const queryResult = deferred<readonly Record<string, unknown>[]>();
    const { client, outcome } = authClient(async () => {
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
    const { client, outcome } = authClient(async () => {
      throw queryError;
    });

    await expect(
      client.transaction(async (handle) => {
        void handle.query('SELECT forgotten', []);
      }),
    ).rejects.toBe(queryError);
    expect(outcome()).toBe('rolled back');
  });

  it('uses Prisma execute for DML without returning rows', async () => {
    const { client, queryRaw, executeRaw } = authClient(async () => []);

    await expect(
      client.query('UPDATE web_sessions SET revoked_at = $1', [new Date()]),
    ).resolves.toEqual([]);

    expect(queryRaw).not.toHaveBeenCalled();
    expect(executeRaw).toHaveBeenCalledWith(
      'UPDATE web_sessions SET revoked_at = $1',
      expect.any(Date),
    );
  });

  it('preserves the PostgreSQL SQLSTATE from Prisma adapter errors', async () => {
    const adapterError = {
      code: 'P2010',
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: '23505',
            originalMessage: 'duplicate key',
          },
        },
      },
    };
    const { client } = authClient(async () => {
      throw adapterError;
    });

    await expect(client.query('SELECT duplicate', [])).rejects.toMatchObject({
      code: '23505',
      message: 'duplicate key',
      cause: adapterError,
    });
  });

  it('maps raw values back to the PostgreSQL client types', async () => {
    const createdAt = new Date('2026-10-11T00:00:00.000Z');
    const bytes = new Uint8Array([1, 2, 3]);
    const { client } = authClient(async () => [
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
    expect(Buffer.isBuffer(rows[0]?.binary)).toBe(true);
  });
});
