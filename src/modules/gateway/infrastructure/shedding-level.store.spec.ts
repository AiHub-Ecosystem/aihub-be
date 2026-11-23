import {
  SHEDDING_LEVEL_KEY,
  type SheddingLevelRedisClient,
  SheddingLevelStore,
} from './shedding-level.store';

class FakeRedis implements SheddingLevelRedisClient {
  readonly values = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  getCalls = 0;
  writes = 0;
  failReads = false;

  waitUntilReady(_signal: AbortSignal): Promise<boolean> {
    return Promise.resolve(true);
  }

  async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    if (this.failReads) throw new Error('redis down');
    const value = this.values.get(key);
    return value === undefined ? null : String(value);
  }

  async eval(
    _script: string,
    _numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    const key = String(args[0]);
    const level = Number(args[1]);
    const current = this.values.get(key) ?? 0;
    if (level < current) return current;
    this.writes += 1;
    this.values.set(key, level);
    this.ttls.set(key, Number(args[2]));
    return level;
  }
}

describe('SheddingLevelStore', () => {
  it('applies the higher of its own level and a peer level', async () => {
    const redis = new FakeRedis();
    const store = new SheddingLevelStore(redis);

    await store.setLocal(1);
    await store.refresh();
    expect(store.current()).toBe(1);

    await redis.eval('', 1, SHEDDING_LEVEL_KEY, 2, 15);
    await store.refresh();
    expect(store.current()).toBe(2);
  });

  it('never lowers the shared level from an instance that lagged behind', async () => {
    const redis = new FakeRedis();
    redis.values.set(SHEDDING_LEVEL_KEY, 2);
    const store = new SheddingLevelStore(redis);

    await store.setLocal(1);

    expect(redis.values.get(SHEDDING_LEVEL_KEY)).toBe(2);
    expect(store.current()).toBe(1);
  });

  it('fails open when Redis cannot be read', async () => {
    const redis = new FakeRedis();
    redis.failReads = true;
    const store = new SheddingLevelStore(redis);

    await store.refresh();

    expect(store.current()).toBe(0);
  });

  it('applies its own level with no Redis at all', async () => {
    const store = new SheddingLevelStore(undefined);

    await store.setLocal(2);
    await store.refresh();

    expect(store.current()).toBe(2);
  });

  it('keeps the last known peer level while a refresh fails', async () => {
    const redis = new FakeRedis();
    redis.values.set(SHEDDING_LEVEL_KEY, 1);
    let now = 0;
    const store = new SheddingLevelStore(redis, undefined, () => now);
    await store.refresh();

    redis.failReads = true;
    await store.refresh();

    expect(store.current()).toBe(1);

    // A peer's level is only trusted for as long as the key it came from
    // would live; past that, an outage must fail open instead of shedding.
    now += 16_000;
    await store.refresh();
    expect(store.current()).toBe(0);
  });

  it('does not let a recovered instance renew a higher peer level', async () => {
    const redis = new FakeRedis();
    redis.values.set(SHEDDING_LEVEL_KEY, 2);
    redis.ttls.set(SHEDDING_LEVEL_KEY, 15);
    const store = new SheddingLevelStore(redis);

    await store.setLocal(1);

    expect(redis.values.get(SHEDDING_LEVEL_KEY)).toBe(2);
    // The 2 expires on its own: the level-1 publisher wrote nothing, so it
    // cannot renew the key that keeps a level 2 alive.
    expect(redis.writes).toBe(0);
  });
});
