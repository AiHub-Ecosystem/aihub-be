import {
  SHEDDING_LEVEL_KEY,
  type SheddingLevelRedisClient,
  SheddingLevelStore,
} from './shedding-level.store';

class FakeRedis implements SheddingLevelRedisClient {
  readonly values = new Map<string, number>();
  getCalls = 0;
  failReads = false;

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
    const current = Math.max(this.values.get(key) ?? 0, level);
    this.values.set(key, current);
    return current;
  }
}

describe('SheddingLevelStore', () => {
  it('applies the higher of its own level and a peer level', async () => {
    const redis = new FakeRedis();
    const store = new SheddingLevelStore(redis);

    store.setLocal(1);
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

    store.setLocal(1);
    // The fake's `eval` writes before its first await, so the raise is visible.
    await Promise.resolve();

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

    store.setLocal(2);
    await store.refresh();

    expect(store.current()).toBe(2);
  });

  it('keeps the last known peer level while a refresh fails', async () => {
    const redis = new FakeRedis();
    redis.values.set(SHEDDING_LEVEL_KEY, 1);
    const store = new SheddingLevelStore(redis);
    await store.refresh();

    redis.failReads = true;
    await store.refresh();

    expect(store.current()).toBe(1);
  });
});
