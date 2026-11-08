import {
  AVATAR_COMPLETION_DEADLINE_MS,
  AVATAR_COMPLETION_LOCK_TRANSACTION_TIMEOUT_MS,
  AVATAR_LOCK_IDLE_TRANSACTION_TIMEOUT_MS,
} from '@/modules/avatar/application/avatar-upload.policy';
import type { PrismaClient } from '@prisma-client/client';
import { PostgresAvatarRepository } from './postgres-avatar.repository';

const USER = 'usr_01J00000000000000000000000';

describe('PostgresAvatarRepository.withUserLock', () => {
  it('sets the transaction-local idle timeout before locking and calling the operation', async () => {
    let idleTimeoutSet = false;
    let lockAcquired = false;
    let callbackRanAfterSetup = false;
    let setConfigVal: unknown;
    let lockVal: unknown;
    let options: unknown;
    const transaction = {
      $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
        if (sql.includes('set_config')) {
          idleTimeoutSet = true;
          setConfigVal = values[0];
        }
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
        if (sql.includes('pg_advisory_xact_lock')) {
          lockAcquired = true;
          lockVal = values[0];
        }
        return 1;
      },
    };
    const prisma = {
      $transaction: async <T>(
        callback: (tx: typeof transaction) => Promise<T>,
        transactionOptions: unknown,
      ) => {
        options = transactionOptions;
        return callback(transaction);
      },
    } as unknown as PrismaClient;

    const result = await new PostgresAvatarRepository(prisma).withUserLock(
      USER,
      async () => {
        callbackRanAfterSetup = idleTimeoutSet && lockAcquired;
        return 'completed';
      },
    );

    expect(result).toBe('completed');
    expect(callbackRanAfterSetup).toBe(true);
    expect(setConfigVal).toBe(`${AVATAR_LOCK_IDLE_TRANSACTION_TIMEOUT_MS}ms`);
    expect(lockVal).toBe(`avatar:${USER}`);
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
