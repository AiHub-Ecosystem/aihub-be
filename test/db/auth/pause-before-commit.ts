import type { PrismaClient } from '@prisma-client/client';
import type { Pool } from 'pg';

import { interceptStatements } from '@/modules/persistence/testing/query-fake-client';
import { waitForBlockedBy } from '../shared/database';
import type { PostgresAuthClient } from './postgres-auth.client';

/**
 * The real client with `$transaction` held open after its callback, so a
 * spec decides when the lock the repository took is released.
 */
export function pauseBeforeCommit(client: PostgresAuthClient): {
  readonly client: PostgresAuthClient;
  readonly locked: Promise<number>;
  readonly release: () => void;
} {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let report = (_pid: number) => {};
  const locked = new Promise<number>((resolve) => {
    report = resolve;
  });
  return {
    locked,
    release,
    // Holds the transaction open after its callback: the real client, with
    // `$transaction` replaced, so whatever statements the repository issues
    // inside it are the engine's and the lock outlives the callback.
    client: new Proxy(client, {
      get(target, property) {
        if (property !== '$transaction') {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (callback: (transaction: unknown) => Promise<unknown>) =>
          target.$transaction(async (transaction) => {
            const result = await callback(transaction);
            const rows = await transaction.$queryRawUnsafe<{ pid: number }[]>(
              'SELECT pg_backend_pid() AS pid',
            );
            const pid = rows[0]?.pid;
            if (typeof pid !== 'number')
              throw new Error('transaction reported no backend pid');
            report(pid);
            await released;
            return result;
          });
      },
    }) as PostgresAuthClient,
  };
}

/**
 * Runs `first` on a client that holds its transaction open, starts `second`
 * once `first` holds its locks, and releases `first` only after `second` is
 * queued behind it. Both outcomes come back, so a spec asserts the ordering.
 */
export async function racePausedFirst<First, Second>(
  pool: Pool,
  client: PostgresAuthClient,
  first: (pausedClient: PostgresAuthClient) => Promise<First>,
  second: () => Promise<Second>,
): Promise<readonly [First, Second]> {
  const paused = pauseBeforeCommit(client);
  const firstResult = first(paused.client);
  let secondResult: Promise<Second> | undefined;
  try {
    const pid = await Promise.race([
      paused.locked,
      firstResult.then(() => {
        throw new Error('transaction finished before the commit barrier');
      }),
    ]);
    secondResult = second();
    await waitForBlockedBy(pool, pid);
    paused.release();
    return await Promise.all([firstResult, secondResult]);
  } finally {
    paused.release();
    await Promise.allSettled([firstResult, secondResult]);
  }
}

/**
 * The real client whose transactions stop at the first statement `stopAt`
 * accepts, after the statements before it have taken their locks. `pid` is the
 * backend of the stopped transaction, for `waitForBlockedBy`.
 */
export function pauseAtStatement(
  client: PostgresAuthClient,
  stopAt: Parameters<typeof interceptStatements>[1] extends (
    statement: infer Statement,
  ) => unknown
    ? (statement: Statement) => boolean
    : never,
): {
  readonly client: PostgresAuthClient;
  readonly reached: Promise<void>;
  readonly pid: () => number;
  readonly resume: () => void;
} {
  let resume = () => {};
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let reach = () => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  let backendPid = 0;
  return {
    reached,
    resume,
    pid: () => backendPid,
    client: new Proxy(client, {
      get(target, property) {
        if (property !== '$transaction') {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (callback: (transaction: PrismaClient) => Promise<unknown>) =>
          target.$transaction(async (transaction) => {
            const rows = await transaction.$queryRawUnsafe<{ pid: number }[]>(
              'SELECT pg_backend_pid() AS pid',
            );
            backendPid = rows[0]?.pid ?? 0;
            return callback(
              interceptStatements(
                transaction as unknown as PrismaClient,
                async (statement) => {
                  if (stopAt(statement)) {
                    reach();
                    await resumed;
                  }
                },
              ),
            );
          });
      },
    }) as PostgresAuthClient,
  };
}
