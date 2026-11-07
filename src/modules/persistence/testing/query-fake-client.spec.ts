import type { QueryFake } from './query-fake-client';
import { ScriptedPrisma, prismaFromQueryFake } from './query-fake-client';

interface RecordingFake extends Omit<QueryFake, 'transaction'> {
  queries: Array<{ text: string; values: readonly unknown[] }>;
  transactionOptions: unknown[];
  transaction<T>(
    callback: (handle: {
      query(
        text: string,
        values: readonly unknown[],
      ): Promise<readonly unknown[]>;
    }) => Promise<T>,
    options?: unknown,
  ): Promise<T>;
}

function recordingFake(): RecordingFake {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const transactionOptions: unknown[] = [];
  const query = async (text: string, values: readonly unknown[]) => {
    queries.push({ text, values: [...values] });
    return [{ ok: true }];
  };
  return {
    queries,
    transactionOptions,
    query,
    transaction: async (callback, options) => {
      transactionOptions.push(options);
      return callback({ query });
    },
  };
}

describe('query-fake-client shared behavior', () => {
  it('both bridges default $executeRawUnsafe to 1', async () => {
    const fake = recordingFake();
    const viaFake = prismaFromQueryFake(fake);
    await expect(
      viaFake.$executeRawUnsafe('UPDATE t SET a = $1', 1),
    ).resolves.toBe(1);

    const scripted = new ScriptedPrisma();
    await expect(
      scripted.client().$executeRawUnsafe('UPDATE t SET a = $1', 1),
    ).resolves.toBe(1);
  });

  it('scripted override on ScriptedPrisma still wins over the default', async () => {
    const scripted = new ScriptedPrisma();
    scripted.outside = [0];
    await expect(
      scripted.client().$executeRawUnsafe('UPDATE t SET a = 1'),
    ).resolves.toBe(0);
  });

  it('both bridges record $transaction options instead of dropping them', async () => {
    const fake = recordingFake();
    const viaFake = prismaFromQueryFake(fake);
    await viaFake.$transaction(async () => 'ok', {
      maxWait: 1000,
      timeout: 5000,
      isolationLevel: 'RepeatableRead',
    });

    const scripted = new ScriptedPrisma();
    await scripted.client().$transaction(async () => 'ok', {
      maxWait: 1000,
      timeout: 5000,
      isolationLevel: 'RepeatableRead',
    });

    expect(fake.transactionOptions).toEqual([
      expect.objectContaining({
        maxWait: 1000,
        timeout: 5000,
        isolationLevel: 'RepeatableRead',
      }),
    ]);
    expect(scripted.transactionOptions).toEqual([
      { maxWait: 1000, timeout: 5000, isolationLevel: 'RepeatableRead' },
    ]);
  });

  it('prismaFromQueryFake forwards transaction options through to the fake', async () => {
    const fake = recordingFake();
    const client = prismaFromQueryFake(fake);
    await client.$transaction(async () => 'outer', {
      isolationLevel: 'RepeatableRead',
    });
    await client.$transaction(async () => 'outer2', {
      isolationLevel: 'ReadCommitted',
    });
    expect(fake.transactionOptions).toEqual([
      { isolationLevel: 'RepeatableRead' },
      { isolationLevel: 'ReadCommitted' },
    ]);
  });
});
