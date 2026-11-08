import {
  AVATAR_COMPLETION_DEADLINE_MS,
  AVATAR_COMPLETION_LOCK_TRANSACTION_TIMEOUT_MS,
  AVATAR_LOCK_IDLE_TRANSACTION_TIMEOUT_MS,
} from '@/modules/avatar/application/avatar-upload.policy';
import type { PrismaClient } from '@prisma-client/client';
import { PostgresAvatarRepository } from './postgres-avatar.repository';

const USER = 'usr_01J00000000000000000000000';
const IDLE_TIMEOUT_SQL =
  "SELECT set_config('idle_in_transaction_session_timeout', $1, true)";
const LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

describe('PostgresAvatarRepository.withUserLock', () => {
  it('sets the transaction-local idle timeout before locking and calling the operation', async () => {
    const order: string[] = [];
    const rawCalls: { sql: string; values: unknown[] }[] = [];
    let options: unknown;
    const transaction = {
      $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
        order.push('query');
        rawCalls.push({ sql, values });
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
        order.push('execute');
        rawCalls.push({ sql, values });
        return 1;
      },
    };
    const prisma = {
      $transaction: async <T>(
        callback: (tx: typeof transaction) => Promise<T>,
        transactionOptions: unknown,
      ) => {
        options = transactionOptions;
        order.push('begin');
        return callback(transaction);
      },
    } as unknown as PrismaClient;

    const result = await new PostgresAvatarRepository(prisma).withUserLock(
      USER,
      async () => {
        order.push('callback');
        return 'completed';
      },
    );

    expect(result).toBe('completed');
    expect(order).toEqual(['begin', 'query', 'execute', 'callback']);
    expect(rawCalls).toEqual([
      {
        sql: IDLE_TIMEOUT_SQL,
        values: [`${AVATAR_LOCK_IDLE_TRANSACTION_TIMEOUT_MS}ms`],
      },
      { sql: LOCK_SQL, values: [`avatar:${USER}`] },
    ]);
    expect(options).toMatchObject({
      maxWait: 1_000,
      timeout: AVATAR_COMPLETION_LOCK_TRANSACTION_TIMEOUT_MS,
    });
  });

  it('keeps the completion deadline below transaction and server idle timeouts', () => {
    expect(AVATAR_COMPLETION_DEADLINE_MS).toBeLessThan(
      AVATAR_COMPLETION_LOCK_TRANSACTION_TIMEOUT_MS,
    );
    expect(AVATAR_COMPLETION_LOCK_TRANSACTION_TIMEOUT_MS).toBeLessThanOrEqual(
      AVATAR_LOCK_IDLE_TRANSACTION_TIMEOUT_MS,
    );
  });

  it.each([
    {
      kind: 'lock timeout',
      code: '55P03',
      message: 'canceling statement due to lock timeout',
    },
    {
      kind: 'statement timeout',
      code: '57014',
      message: 'canceling statement due to statement timeout',
    },
  ])(
    'makes a Postgres $kind retryable as database unavailable',
    async ({ code, message }) => {
      const timeout = Object.assign(new Error(message), { code });
      const prisma = {
        $transaction: async () => {
          throw timeout;
        },
      } as unknown as PrismaClient;

      await expect(
        new PostgresAvatarRepository(prisma).withUserLock(
          USER,
          async () => 'unreachable',
        ),
      ).rejects.toMatchObject({
        code: 'DATABASE_UNAVAILABLE',
        retryable: true,
      });
    },
  );
});
