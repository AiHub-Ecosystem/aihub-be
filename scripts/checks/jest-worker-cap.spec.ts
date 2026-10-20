import {
  BYTES_PER_WORKER,
  DEFAULT_MAX_WORKERS,
  REQUEST_VARIABLE,
  resolveMaxWorkers,
  resolveUnitLaneWorkers,
} from './jest-worker-cap.cjs';

const gib = (value: number) => value * 1024 ** 3;

describe('unit lane worker cap', () => {
  it('keeps today two workers on a healthy machine', () => {
    expect(resolveMaxWorkers({ freeBytes: gib(16) })).toEqual({
      maxWorkers: 2,
      source: 'memory',
      capped: false,
    });
  });

  it('refuses the second worker at the memory level that killed a real run', () => {
    // Measured on 2026-10-20: two workers died from heap exhaustion with 2.64 GiB free.
    expect(resolveMaxWorkers({ freeBytes: gib(2.64) })).toEqual({
      maxWorkers: 1,
      source: 'memory',
      capped: true,
    });
  });

  it('runs one worker rather than zero when nothing fits', () => {
    expect(resolveMaxWorkers({ freeBytes: gib(0.2) }).maxWorkers).toBe(1);
    expect(resolveMaxWorkers({ freeBytes: 1 }).maxWorkers).toBe(1);
  });

  it('grants the second worker as soon as a full budget is free', () => {
    expect(
      resolveMaxWorkers({ freeBytes: DEFAULT_MAX_WORKERS * BYTES_PER_WORKER })
        .maxWorkers,
    ).toBe(2);
    expect(
      resolveMaxWorkers({
        freeBytes: DEFAULT_MAX_WORKERS * BYTES_PER_WORKER - 1,
      }).maxWorkers,
    ).toBe(1);
  });

  it.each([NaN, 0, -gib(1), undefined])(
    'falls back to the historical cap when memory is unknown (%p)',
    (freeBytes) => {
      expect(resolveMaxWorkers({ freeBytes })).toEqual({
        maxWorkers: DEFAULT_MAX_WORKERS,
        source: 'unknown',
        capped: false,
      });
    },
  );

  it('never exceeds the cap it replaced, whatever the free memory', () => {
    for (const freeBytes of [
      gib(0),
      gib(1),
      gib(8),
      gib(64),
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(resolveMaxWorkers({ freeBytes }).maxWorkers).toBeLessThanOrEqual(
        DEFAULT_MAX_WORKERS,
      );
    }
  });

  it('honours an explicit pin and does not lower it', () => {
    expect(resolveMaxWorkers({ requested: '3', freeBytes: gib(1) })).toEqual({
      maxWorkers: 3,
      source: 'requested',
      capped: false,
    });
  });

  it.each(['0', '-1', 'two', '1.5'])(
    'rejects an unusable pin (%p) by name',
    (requested) => {
      expect(() => resolveMaxWorkers({ requested })).toThrow(REQUEST_VARIABLE);
    },
  );

  it('accepts an empty pin as no pin at all', () => {
    expect(
      resolveMaxWorkers({ requested: '', freeBytes: gib(8) }).maxWorkers,
    ).toBe(2);
    expect(
      resolveMaxWorkers({ requested: null, freeBytes: gib(8) }).maxWorkers,
    ).toBe(2);
    // A blank assignment is how a CI environment unsets a variable.
    expect(
      resolveMaxWorkers({ requested: ' ', freeBytes: gib(8) }).maxWorkers,
    ).toBe(2);
  });

  it('reads the pin from the environment and the memory from the host', () => {
    const resolved = resolveUnitLaneWorkers({
      env: { [REQUEST_VARIABLE]: '1' },
      freeBytes: gib(16),
    });
    expect(resolved).toEqual({
      maxWorkers: 1,
      source: 'requested',
      capped: false,
    });
    expect(
      resolveUnitLaneWorkers({ env: {}, freeBytes: gib(3) }).maxWorkers,
    ).toBe(1);
  });

  it('measures the host it runs on when no memory is injected', () => {
    // Guards against a default argument that throws or returns undefined on a real machine.
    expect(
      resolveUnitLaneWorkers({ env: {} }).maxWorkers,
    ).toBeGreaterThanOrEqual(1);
  });
});
