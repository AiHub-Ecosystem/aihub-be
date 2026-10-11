import { Buffer } from 'node:buffer';

import { Prisma } from '@prisma-client/client';

/**
 * Raw-SQL and transaction plumbing shared by every module that issues SQL
 * through Prisma (ADR-0088). Modules keep their own row mapping; what lives
 * here is what would otherwise be copied between them.
 */

const LIFECYCLE_PROPERTIES: ReadonlySet<PropertyKey> = new Set([
  'then',
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'onApplicationShutdown',
  'beforeApplicationShutdown',
]);

/**
 * A client proxy answers `undefined` to these. `then` keeps `await proxy` from
 * treating it as a thenable, and Nest looks for the lifecycle hooks on every
 * provider it manages, which must not be the first use that reaches a pool.
 */
export function isLifecycleProperty(property: PropertyKey): boolean {
  return LIFECYCLE_PROPERTIES.has(property);
}

function normalizeRawValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Prisma.Decimal.isDecimal(value)) {
    return value.toString();
  }
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  return value;
}

/**
 * Prisma's raw path returns `bigint`, `Decimal`, and `Uint8Array` where `pg`
 * returned strings and `Buffer`. Repositories keep their existing port types by
 * mapping back to what `pg` produced.
 */
export function normalizeRawRows<T extends object>(
  rows: readonly T[],
): readonly T[] {
  return rows.map((source) => {
    const values = source as Record<string, unknown>;
    const row: Record<string, unknown> = {};
    for (const column of Object.keys(values)) {
      row[column] = normalizeRawValue(values[column]);
    }
    return row as T;
  });
}

/**
 * DML without `RETURNING` has no result set, and Prisma's query path cannot
 * deserialize the empty one, so it goes through `$executeRawUnsafe`.
 */
export function isRowlessWrite(text: string): boolean {
  return (
    /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(text) && !/\bRETURNING\b/i.test(text)
  );
}

/**
 * What Prisma reports for a model operation that failed on a database
 * constraint, by the SQLSTATE `pg` would have thrown for it.
 */
const PRISMA_CODE_SQLSTATE: Readonly<Record<string, string>> = {
  P2002: '23505', // unique_violation
  P2003: '23503', // foreign_key_violation
  P2034: '40001', // serialization_failure (write conflict or deadlock)
};

/**
 * Prisma wraps the driver's error, so callers that branch on a SQLSTATE
 * (unique violation, serialization failure) would not see `error.code`. This
 * returns the error `pg` used to throw: from the driver's own code for a raw
 * statement, and from Prisma's code for a model operation.
 */
export function postgresError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) {
    return error;
  }
  const driverError = Reflect.get(error, 'meta')?.driverAdapterError;
  const cause =
    typeof driverError === 'object' && driverError !== null
      ? Reflect.get(driverError, 'cause')
      : undefined;
  const originalCode =
    typeof cause === 'object' && cause !== null
      ? Reflect.get(cause, 'originalCode')
      : undefined;
  const prismaCode = Reflect.get(error, 'code');
  const code =
    typeof originalCode === 'string'
      ? originalCode
      : typeof prismaCode === 'string'
        ? PRISMA_CODE_SQLSTATE[prismaCode]
        : undefined;
  if (code === undefined) {
    return error;
  }
  const message =
    typeof cause === 'object' && cause !== null
      ? Reflect.get(cause, 'originalMessage')
      : undefined;
  return Object.assign(
    new Error(typeof message === 'string' ? message : String(error)),
    { code, cause: error },
  );
}

export interface TransactionGuardOptions {
  /** The error a statement receives when it starts after the callback settled. */
  readonly expired: () => Error;
  /** Translates a failure from a statement still running when the callback settled. */
  readonly mapFailure?: (reason: unknown) => unknown;
}

const RAW_QUERY_METHODS: ReadonlySet<PropertyKey> = new Set([
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
]);

/**
 * The ADR-0083 lifetime guard: a transaction handle that cannot be used after
 * its callback settles.
 *
 * Every statement the callback starts is tracked, raw or through a model
 * delegate. When the callback settles the handle expires, so a later statement
 * is rejected before it reaches the driver. Statements already running are
 * drained before Prisma commits or rolls back, which keeps the pooled
 * connection from being released under a query. The callback's own error stays
 * primary.
 */
export function runGuardedTransaction<T>(
  transaction: Prisma.TransactionClient,
  callback: (guarded: Prisma.TransactionClient) => Promise<T>,
  options: TransactionGuardOptions,
): Promise<T> {
  let active = true;
  const inFlight: Promise<unknown>[] = [];

  const track =
    (method: (...args: unknown[]) => unknown, owner: object) =>
    (...args: unknown[]): Promise<unknown> => {
      if (!active) {
        return Promise.reject(options.expired());
      }
      const query = Promise.resolve(Reflect.apply(method, owner, args));
      inFlight.push(query);
      void query.catch(() => undefined);
      return query;
    };

  const guarded = new Proxy(transaction, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;

      if (RAW_QUERY_METHODS.has(property) && typeof value === 'function') {
        return track(value as (...args: unknown[]) => unknown, target);
      }

      // A model delegate (`transaction.apiKey`): its methods are statements too.
      if (
        typeof property === 'string' &&
        !property.startsWith('$') &&
        typeof value === 'object' &&
        value !== null
      ) {
        return new Proxy(value, {
          get(delegate, method) {
            const member = Reflect.get(delegate, method, delegate) as unknown;
            return typeof member === 'function'
              ? track(member as (...args: unknown[]) => unknown, delegate)
              : member;
          },
        });
      }

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return (async () => {
    let result!: T;
    let callbackError: { readonly value: unknown } | undefined;
    try {
      result = await callback(guarded);
    } catch (error) {
      callbackError = { value: error };
    }
    active = false;

    const settled = await Promise.allSettled(inFlight);
    if (callbackError !== undefined) {
      throw callbackError.value;
    }
    const failed = settled.find(
      (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
    );
    if (failed !== undefined) {
      throw options.mapFailure?.(failed.reason) ?? failed.reason;
    }
    return result;
  })();
}
