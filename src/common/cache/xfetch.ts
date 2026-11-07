import { Singleflight } from '@/common/singleflight';

export interface XFetchCacheOptions {
  /** Full cache lifetime in ms. */
  ttlMs: number;
  /** Steepness of the early-refresh probability; 1 keeps expected early refresh at one fetch duration. */
  beta?: number;
  /** Injectable clock (epoch ms) for tests. */
  now?: () => number;
  /** Injectable uniform random in (0, 1] for tests. */
  random?: () => number;
}

interface XFetchEntry<V> {
  readonly value: V;
  /** Clock reading (ms) when the load completed. */
  readonly cachedAt: number;
  readonly ttlMs: number;
  /** Measured load duration in ms (the XFetch delta). */
  readonly fetchDurationMs: number;
}

function readRandom(random: () => number): number {
  const value = random();
  // ponytail: clamps ln(random) away from Infinity when random() can return 0
  return Math.max(value, 1e-12);
}

/**
 * Lock-free probabilistic early expiration (XFetch, Vattani et al. 2015).
 * Readers approaching TTL trigger a background refresh with rising
 * probability, so expiration is revalidated before a stampede can form.
 */
export class XFetchCache<K, V> {
  private readonly entries = new Map<K, XFetchEntry<V>>();
  private readonly flights = new Singleflight<K, V>();
  private readonly ttlMs: number;
  private readonly beta: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly load: (key: K) => Promise<V>,
    options: XFetchCacheOptions,
  ) {
    this.ttlMs = options.ttlMs;
    this.beta = options.beta ?? 1;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  async get(key: K): Promise<V> {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return this.refresh(key);
    }

    const nowMs = this.now();
    const ageMs = nowMs - entry.cachedAt;
    if (ageMs >= entry.ttlMs) {
      return this.refresh(key);
    }

    const remainingMs = entry.ttlMs - ageMs;
    const earlyRefreshBudgetMs =
      -this.beta * entry.fetchDurationMs * Math.log(readRandom(this.random));
    if (earlyRefreshBudgetMs > remainingMs) {
      // ponytail: background failure keeps serving stale; true expiry retries synchronously
      void this.refresh(key).catch(() => undefined);
    }
    return entry.value;
  }

  private async refresh(key: K): Promise<V> {
    return this.flights.run(key, async () => {
      const startedAt = this.now();
      const value = await this.load(key);
      this.entries.set(key, {
        value,
        cachedAt: this.now(),
        ttlMs: this.ttlMs,
        fetchDurationMs: this.now() - startedAt,
      });
      return value;
    });
  }
}
