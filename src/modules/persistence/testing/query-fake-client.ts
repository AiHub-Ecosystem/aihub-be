import type { PrismaClient } from '@prisma-client/client';

/** The one statement entry point a query-shaped fake or wrapper implements. */
export interface QueryHandle {
  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]>;
}

/** A fake that answers statements, and opens transactions when it can. */
export interface QueryFake extends QueryHandle {
  transaction?<T>(callback: (handle: QueryHandle) => Promise<T>): Promise<T>;
}

function rawMethods(handle: QueryHandle) {
  return {
    $queryRawUnsafe: async (text: string, ...values: unknown[]) =>
      handle.query(text, values),
    $executeRawUnsafe: async (text: string, ...values: unknown[]) => {
      await handle.query(text, values);
      return 0;
    },
  };
}

/**
 * A Prisma-shaped client whose statements go to a fake that matches on SQL
 * text. It exists for specs that script statements or inject failures by their
 * text; a repository takes Prisma, so the fake is adapted rather than injected.
 *
 * Only raw statements and `$transaction` exist on it. A repository that reads
 * through a model delegate needs a fake of its own.
 */
export function prismaFromQueryFake(fake: QueryFake): PrismaClient {
  return {
    ...rawMethods(fake),
    $transaction: async (
      callback: (transaction: unknown) => Promise<unknown>,
    ) => {
      if (fake.transaction === undefined) {
        throw new Error('This query fake does not open transactions');
      }
      return fake.transaction((handle) => callback(rawMethods(handle)));
    },
  } as unknown as PrismaClient;
}

export type StatementProbe =
  | {
      readonly kind: 'raw';
      readonly text: string;
      readonly values: readonly unknown[];
    }
  | {
      readonly kind: 'model';
      readonly model: string;
      readonly action: string;
      readonly args: readonly unknown[];
    };

/**
 * The real client with a hook in front of every statement, raw or through a
 * model delegate, inside a transaction or outside it. A hook that throws fails
 * that statement before it reaches the database, which is how a spec makes one
 * write of a unit of work fail and checks the rest rolled back.
 */
export function interceptStatements(
  prisma: PrismaClient,
  before: (statement: StatementProbe) => void | Promise<void>,
): PrismaClient {
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(owner, property) {
        const value = Reflect.get(owner, property, owner) as unknown;

        if (
          (property === '$queryRawUnsafe' ||
            property === '$executeRawUnsafe') &&
          typeof value === 'function'
        ) {
          return async (text: string, ...values: unknown[]) => {
            await before({ kind: 'raw', text, values });
            return Reflect.apply(value, owner, [text, ...values]);
          };
        }

        if (property === '$transaction' && typeof value === 'function') {
          return (callback: unknown, options?: unknown) =>
            typeof callback === 'function'
              ? Reflect.apply(value, owner, [
                  (transaction: object) =>
                    (callback as (tx: object) => unknown)(wrap(transaction)),
                  options,
                ])
              : Reflect.apply(value, owner, [callback, options]);
        }

        if (
          typeof property === 'string' &&
          !property.startsWith('$') &&
          typeof value === 'object' &&
          value !== null
        ) {
          return new Proxy(value, {
            get(delegate, action) {
              const method = Reflect.get(delegate, action, delegate) as unknown;
              if (typeof method !== 'function' || typeof action !== 'string') {
                return method;
              }
              return async (...args: unknown[]) => {
                await before({ kind: 'model', model: property, action, args });
                return Reflect.apply(method, delegate, args);
              };
            },
          });
        }

        return typeof value === 'function' ? value.bind(owner) : value;
      },
    });

  return wrap(prisma);
}
