import type { Prisma } from '@prisma-client/client';
import {
  isRowlessWrite,
  normalizeRawRows,
  postgresError,
  runGuardedTransaction,
} from './prisma-raw';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeTransaction(findMany: () => Promise<unknown>) {
  const findManyMock = jest.fn(findMany);
  const queryRaw = jest.fn(async () => []);
  const transaction = {
    apiKey: { findMany: findManyMock },
    $queryRawUnsafe: queryRaw,
  } as unknown as Prisma.TransactionClient;
  return { transaction, findMany: findManyMock, queryRaw };
}

const expired = () => new Error('handle expired');

describe('runGuardedTransaction', () => {
  it('rejects a model delegate call made after the callback settled', async () => {
    const { transaction, findMany } = fakeTransaction(async () => []);

    const handle = await runGuardedTransaction(
      transaction,
      async (guarded) => guarded,
      { expired },
    );

    await expect(
      (
        handle as unknown as { apiKey: { findMany(): Promise<unknown> } }
      ).apiKey.findMany(),
    ).rejects.toThrow('handle expired');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('rejects a raw call made after the callback settled', async () => {
    const { transaction, queryRaw } = fakeTransaction(async () => []);

    const handle = await runGuardedTransaction(
      transaction,
      async (guarded) => guarded,
      { expired },
    );

    await expect(handle.$queryRawUnsafe('SELECT 1')).rejects.toThrow(
      'handle expired',
    );
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('drains a model delegate call the callback left in flight', async () => {
    const started = deferred<void>();
    const result = deferred<unknown>();
    const { transaction } = fakeTransaction(async () => {
      started.resolve();
      return result.promise;
    });

    let settled = false;
    const running = runGuardedTransaction(
      transaction,
      async (guarded) => {
        void (
          guarded as unknown as { apiKey: { findMany(): Promise<unknown> } }
        ).apiKey.findMany();
      },
      { expired },
    ).then((value) => {
      settled = true;
      return value;
    });
    await started.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    result.resolve([]);
    await running;
    expect(settled).toBe(true);
  });

  it('keeps the callback error primary over a failed pending call', async () => {
    const callbackError = new Error('callback failed');
    const { transaction } = fakeTransaction(async () => {
      throw new Error('pending failed');
    });

    await expect(
      runGuardedTransaction(
        transaction,
        async (guarded) => {
          void (
            guarded as unknown as { apiKey: { findMany(): Promise<unknown> } }
          ).apiKey.findMany();
          throw callbackError;
        },
        { expired },
      ),
    ).rejects.toBe(callbackError);
  });

  it('translates the failure of a call the callback left unawaited', async () => {
    const { transaction } = fakeTransaction(async () => {
      throw new Error('raw failure');
    });

    await expect(
      runGuardedTransaction(
        transaction,
        async (guarded) => {
          void (
            guarded as unknown as { apiKey: { findMany(): Promise<unknown> } }
          ).apiKey.findMany();
        },
        { expired, mapFailure: () => new Error('translated') },
      ),
    ).rejects.toThrow('translated');
  });
});

describe('raw SQL helpers', () => {
  it('routes DML without RETURNING to the execute path', () => {
    expect(isRowlessWrite('UPDATE t SET a = $1')).toBe(true);
    expect(isRowlessWrite('  insert into t values ($1)')).toBe(true);
    expect(isRowlessWrite('UPDATE t SET a = $1 RETURNING id')).toBe(false);
    expect(isRowlessWrite('SELECT 1')).toBe(false);
  });

  it('maps bigint, Decimal and Uint8Array back to pg types', () => {
    const rows = normalizeRawRows([
      { count: 9_007_199_254_740_993n, bytes: new Uint8Array([1, 2]) },
    ]);

    expect(rows[0]?.count).toBe('9007199254740993');
    expect(Buffer.isBuffer(rows[0]?.bytes)).toBe(true);
  });

  it('surfaces the SQLSTATE of a wrapped driver error', () => {
    const wrapped = {
      meta: {
        driverAdapterError: {
          cause: { originalCode: '23505', originalMessage: 'duplicate' },
        },
      },
    };

    expect(postgresError(wrapped)).toMatchObject({
      code: '23505',
      message: 'duplicate',
    });
    expect(postgresError('plain')).toBe('plain');
  });
});
