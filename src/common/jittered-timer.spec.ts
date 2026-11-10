import { JitteredTimer, jitteredDelayMs, staggerMs } from './jittered-timer';

/** Hands out the given draws in turn, then repeats the last one. */
function draws(...values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

describe('jitteredDelayMs', () => {
  it('spreads a delay ten percent either side of its base', () => {
    expect(jitteredDelayMs(10_000, () => 0)).toBe(9_000);
    expect(jitteredDelayMs(10_000, () => 0.5)).toBe(10_000);
    expect(jitteredDelayMs(10_000, () => 0.999_9)).toBe(10_999);
  });
});

describe('staggerMs', () => {
  it('draws an offset inside its window', () => {
    expect(staggerMs(1_000, () => 0)).toBe(0);
    expect(staggerMs(1_000, () => 0.999_9)).toBe(999);
  });
});

describe('JitteredTimer', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('staggers its first tick within one base interval, then re-arms each tick with a jittered delay', async () => {
    jest.useFakeTimers();
    const tick = jest.fn();
    const timer = new JitteredTimer(
      tick,
      1_000,
      undefined,
      draws(0.25, 0, 0.75),
    );

    timer.start();
    await jest.advanceTimersByTimeAsync(249);
    expect(tick).toHaveBeenCalledTimes(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(899);
    expect(tick).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(1_049);
    expect(tick).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(3);
    timer.stop();
  });

  it('takes its first delay from start and later ones from a caller-supplied schedule', async () => {
    jest.useFakeTimers();
    const tick = jest.fn();
    const timer = new JitteredTimer(tick, 1_000, () => 30);

    timer.start(70);
    await jest.advanceTimersByTimeAsync(70);
    expect(tick).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30);
    expect(tick).toHaveBeenCalledTimes(2);
    timer.stop();
  });

  it('arms one timer however often it is started', async () => {
    jest.useFakeTimers();
    const tick = jest.fn();
    const timer = new JitteredTimer(tick, 1_000, () => 100);

    timer.start(100);
    timer.start(100);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(100);
    expect(tick).toHaveBeenCalledTimes(1);
    timer.stop();
  });

  it('arms no further tick once stopped, even when stopped from inside a tick', async () => {
    jest.useFakeTimers();
    let timer: JitteredTimer | undefined;
    const tick = jest.fn(() => timer?.stop());
    timer = new JitteredTimer(tick, 1_000, undefined, () => 0.5);

    timer.start();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(tick).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels its pending first tick when stopped before it fires', async () => {
    jest.useFakeTimers();
    const tick = jest.fn();
    const timer = new JitteredTimer(tick, 1_000);

    timer.start();
    timer.stop();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(tick).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
