export interface BloomFilterOptions {
  readonly capacity?: number | undefined;
  readonly falsePositiveRate?: number | undefined;
}

const DEFAULT_CAPACITY = 100_000;
const DEFAULT_FALSE_POSITIVE_RATE = 0.00001; // 0.001%
const LN2 = Math.LN2;
const LN2_SQUARED = LN2 * LN2;
const FNV_PRIME = 0x01000193;

export class InProcessBloomFilter {
  readonly capacity: number;
  readonly targetFalsePositiveRate: number;
  readonly bitCount: number;
  readonly hashCount: number;
  private readonly bitset: Uint8Array;
  private count = 0;

  constructor(options: BloomFilterOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    const falsePositiveRate =
      options.falsePositiveRate ?? DEFAULT_FALSE_POSITIVE_RATE;

    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError(
        `BloomFilter capacity must be a positive number: ${capacity}`,
      );
    }
    if (
      !Number.isFinite(falsePositiveRate) ||
      falsePositiveRate <= 0 ||
      falsePositiveRate >= 1
    ) {
      throw new RangeError(
        `BloomFilter falsePositiveRate must be in (0, 1): ${falsePositiveRate}`,
      );
    }

    this.capacity = Math.floor(capacity);
    this.targetFalsePositiveRate = falsePositiveRate;

    // m = - (n * ln(p)) / (ln(2)^2)
    const m = Math.ceil(
      (-1 * this.capacity * Math.log(this.targetFalsePositiveRate)) /
        LN2_SQUARED,
    );
    this.bitCount = Math.max(8, m);

    // k = round((m / n) * ln(2))
    const k = Math.round((this.bitCount / this.capacity) * LN2);
    this.hashCount = Math.max(1, k);

    const byteLength = Math.ceil(this.bitCount / 8);
    this.bitset = new Uint8Array(byteLength);
  }

  get byteLength(): number {
    return this.bitset.byteLength;
  }

  get elementCount(): number {
    return this.count;
  }

  add(key: string): void {
    this.traverseBits(key, (byteIndex, bitMask) => {
      const current = this.bitset[byteIndex];
      if (current !== undefined) {
        this.bitset[byteIndex] = current | bitMask;
      }
      return true;
    });
    this.count++;
  }

  has(key: string): boolean {
    return this.traverseBits(key, (byteIndex, bitMask) => {
      const current = this.bitset[byteIndex];
      return current !== undefined && (current & bitMask) !== 0;
    });
  }

  clear(): void {
    this.bitset.fill(0);
    this.count = 0;
  }

  private traverseBits(
    key: string,
    predicate: (byteIndex: number, bitMask: number) => boolean,
  ): boolean {
    const { h1, h2 } = this.computeHashes(key);
    for (let i = 0; i < this.hashCount; i++) {
      const bitIndex = (h1 + i * h2) % this.bitCount;
      const byteIndex = bitIndex >> 3;
      const bitMask = 1 << (bitIndex & 7);
      if (!predicate(byteIndex, bitMask)) {
        return false;
      }
    }
    return true;
  }

  private computeHashes(key: string): { h1: number; h2: number } {
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < key.length; i++) {
      const code = key.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, FNV_PRIME);
      h2 = Math.imul(h2 ^ code, FNV_PRIME);
    }
    return {
      h1: h1 >>> 0,
      h2: (h2 | 1) >>> 0,
    };
  }
}
