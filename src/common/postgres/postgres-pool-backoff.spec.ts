import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BREAKER_COOLDOWN_MS,
  PoolStarvationBreaker,
  isRetryableConnectError,
  nextBackoffMs,
} from './postgres-pool-backoff';

describe('decorrelated jitter backoff', () => {
  it('draws the first wait from [base, base*3]', () => {
    expect(nextBackoffMs(0, () => 0)).toBe(BACKOFF_BASE_MS);
    expect(nextBackoffMs(0, () => 0.999999)).toBe(30);
  });

  it('bases the upper bound on the previous wait, capped', () => {
    // previous 40 ms → upper 120, but the cap holds it at 100.
    expect(nextBackoffMs(40, () => 0.999999)).toBe(BACKOFF_CAP_MS);
    expect(nextBackoffMs(40, () => 0)).toBe(BACKOFF_BASE_MS);
    expect(nextBackoffMs(20, () => 0.999999)).toBe(60);
  });

  it('never schedules a zero wait', () => {
    for (let previous = 0; previous <= 200; previous += 50) {
      expect(nextBackoffMs(previous, () => 0.5)).toBeGreaterThan(0);
    }
  });
});

describe('retryable connection errors', () => {
  it.each([
    [undefined, true],
    ['ECONNREFUSED', true],
    ['ECONNRESET', true],
    ['ETIMEDOUT', true],
    ['08006', true],
    ['53300', true],
    ['57P01', true],
    ['28P01', false],
    ['23505', false],
    ['42P01', false],
  ])('classifies %s as retryable=%s', (code, expected) => {
    const error =
      code === undefined
        ? new Error('socket gone')
        : Object.assign(new Error('x'), { code });
    expect(isRetryableConnectError(error)).toBe(expected);
  });
});

describe('pool starvation breaker', () => {
  let state: string | undefined;
  let now: number;
  const onChange = (next: string) => {
    state = next;
  };

  beforeEach(() => {
    state = undefined;
    now = 1_000;
  });

  function breaker(): PoolStarvationBreaker {
    return new PoolStarvationBreaker(
      onChange,
      () => now,
      () => 0,
    );
  }

  it('stays closed while failures are below the threshold', () => {
    const b = breaker();
    for (let i = 0; i < 4; i += 1) {
      expect(b.admit()).toBe(true);
      expect(b.failure()).toBe(false);
    }
    expect(state).toBeUndefined();
  });

  it('opens after the threshold and sheds until the cooldown ends', () => {
    const b = breaker();
    for (let i = 0; i < 4; i += 1) {
      b.admit();
      b.failure();
    }
    expect(b.failure()).toBe(true);
    expect(state).toBe('open');
    expect(b.admit()).toBe(false);

    now += BREAKER_COOLDOWN_MS - 1;
    expect(b.admit()).toBe(false);

    now += 1;
    expect(b.admit()).toBe(true);
    expect(state).toBe('half_open');
    // One probe at a time while half-open.
    expect(b.admit()).toBe(false);
  });

  it('closes again when the probe succeeds and reopens when it fails', () => {
    const b = breaker();
    for (let i = 0; i < 5; i += 1) {
      b.admit();
      b.failure();
    }
    now += BREAKER_COOLDOWN_MS + 1;
    b.admit();
    b.success();
    expect(state).toBe('closed');
    expect(b.admit()).toBe(true);

    for (let i = 0; i < 5; i += 1) {
      b.admit();
      b.failure();
    }
    expect(state).toBe('open');
  });
});
