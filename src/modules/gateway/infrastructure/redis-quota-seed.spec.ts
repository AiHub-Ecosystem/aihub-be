import { getMetrics } from '@/common/observability/metrics';
import { QUOTA_TTL_SECONDS } from './redis-quota-counter';
import { RedisQuotaSeeder } from './redis-quota-seed';

const NOW = new Date('2026-10-22T08:00:00.000Z');

async function seeds(outcome: string): Promise<number> {
  const line = (await getMetrics())
    .split('\n')
    .find((candidate) =>
      candidate.startsWith(
        `aihub_quota_counter_seeds_total{outcome="${outcome}"} `,
      ),
    );
  return line === undefined ? 0 : Number(line.split(' ').at(-1));
}

describe('RedisQuotaSeeder', () => {
  it('rebuilds the month counter from durable usage with SET NX and the quota TTL', async () => {
    const evalCalls: (readonly (string | number)[])[] = [];
    const billableCount = jest.fn(async () => 42);
    const seeder = new RedisQuotaSeeder(
      {
        eval: async (_script, _keys, ...args) => {
          evalCalls.push(args);
          return 1;
        },
      },
      { billableCount },
    );
    const before = await seeds('seeded');

    await seeder.seed('org_1', NOW);

    expect(billableCount).toHaveBeenCalledWith(
      'org_1',
      new Date('2026-10-01T00:00:00.000Z'),
      new Date('2026-11-01T00:00:00.000Z'),
    );
    expect(evalCalls).toEqual([
      ['aihub:v1:quota:org_1:2026-10', '42', String(QUOTA_TTL_SECONDS)],
    ]);
    expect(await seeds('seeded')).toBe(before + 1);
  });

  it('shares one rebuild between concurrent requests in this process', async () => {
    let release!: () => void;
    const durableRead = new Promise<number>((resolve) => {
      release = () => resolve(7);
    });
    const billableCount = jest.fn(() => durableRead);
    const evalCall = jest.fn(async () => 1);
    const seeder = new RedisQuotaSeeder({ eval: evalCall }, { billableCount });

    const flights = [1, 2, 3].map(() => seeder.seed('org_2', NOW));
    release();
    await Promise.all(flights);

    expect(billableCount).toHaveBeenCalledTimes(1);
    expect(evalCall).toHaveBeenCalledTimes(1);
  });

  it('keeps a counter another writer rebuilt first', async () => {
    const seeder = new RedisQuotaSeeder(
      { eval: async () => 0 },
      { billableCount: async () => 3 },
    );
    const before = await seeds('raced');

    await seeder.seed('org_3', NOW);

    expect(await seeds('raced')).toBe(before + 1);
  });

  it('counts and rethrows a failed durable read, and tries again next time', async () => {
    const billableCount = jest
      .fn<Promise<number>, [string, Date, Date]>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(5);
    const seeder = new RedisQuotaSeeder(
      { eval: async () => 1 },
      { billableCount },
    );
    const before = await seeds('failed');

    await expect(seeder.seed('org_4', NOW)).rejects.toThrow('db down');
    expect(await seeds('failed')).toBe(before + 1);
    await expect(seeder.seed('org_4', NOW)).resolves.toBeUndefined();
  });
});
