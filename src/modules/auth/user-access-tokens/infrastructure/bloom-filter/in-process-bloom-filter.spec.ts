import { InProcessBloomFilter } from './in-process-bloom-filter';

describe('InProcessBloomFilter', () => {
  it('initializes with capacity and target false positive rate under 1MB RAM', () => {
    const filter = new InProcessBloomFilter({
      capacity: 100_000,
      falsePositiveRate: 0.00001, // 0.001%
    });

    expect(filter.capacity).toBe(100_000);
    expect(filter.targetFalsePositiveRate).toBe(0.00001);
    expect(filter.byteLength).toBeLessThan(1024 * 1024); // < 1MB
    expect(filter.hashCount).toBeGreaterThan(0);
    expect(filter.bitCount).toBeGreaterThan(0);
  });

  it('never returns false for an added item (zero false negatives)', () => {
    const filter = new InProcessBloomFilter({
      capacity: 10_000,
      falsePositiveRate: 0.00001,
    });

    const tokens = Array.from({ length: 500 }, (_, i) => `token_jti_${i}`);

    for (const token of tokens) {
      expect(filter.has(token)).toBe(false);
      filter.add(token);
      expect(filter.has(token)).toBe(true);
    }

    // Verify all added tokens still return true
    for (const token of tokens) {
      expect(filter.has(token)).toBe(true);
    }
  });

  it('maintains false positive rate below target probability on unadded items', () => {
    const capacity = 10_000;
    const targetFpr = 0.001; // 0.1% for statistical test with 5000 items
    const filter = new InProcessBloomFilter({
      capacity,
      falsePositiveRate: targetFpr,
    });

    // Add 5,000 items (within capacity)
    for (let i = 0; i < 5_000; i++) {
      filter.add(`revoked_token_${i}`);
    }

    // Test 10,000 unadded items
    let falsePositives = 0;
    const testCount = 10_000;
    for (let i = 0; i < testCount; i++) {
      if (filter.has(`active_token_${i}`)) {
        falsePositives++;
      }
    }

    const measuredFpr = falsePositives / testCount;
    // Measured false positive rate should be <= targetFpr (with generous 3x margin for sampling variation)
    expect(measuredFpr).toBeLessThanOrEqual(targetFpr * 3);
  });

  it('resets bitset on clear()', () => {
    const filter = new InProcessBloomFilter({
      capacity: 1_000,
      falsePositiveRate: 0.00001,
    });

    filter.add('jti_to_clear');
    expect(filter.has('jti_to_clear')).toBe(true);

    filter.clear();
    expect(filter.has('jti_to_clear')).toBe(false);
    expect(filter.elementCount).toBe(0);
  });

  it('rejects invalid constructor parameters', () => {
    expect(() => new InProcessBloomFilter({ capacity: 0 })).toThrow(
      /positive number/u,
    );
    expect(() => new InProcessBloomFilter({ capacity: -10 })).toThrow(
      /positive number/u,
    );
    expect(
      () => new InProcessBloomFilter({ capacity: 100, falsePositiveRate: 0 }),
    ).toThrow(/in \(0, 1\)/u);
    expect(
      () => new InProcessBloomFilter({ capacity: 100, falsePositiveRate: 1 }),
    ).toThrow(/in \(0, 1\)/u);
  });
});
