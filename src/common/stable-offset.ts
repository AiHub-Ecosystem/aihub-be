import { createHash } from 'node:crypto';

/**
 * A fixed offset in `[0, rangeMs)` derived from an id. The same id always gets
 * the same offset, so a key's window, or an Organization's rollover hint, stays
 * stable while different ids spread across the range (#403).
 */
export function stableOffsetMs(id: string, rangeMs: number): number {
  return createHash('sha256').update(id).digest().readUInt32BE(0) % rangeMs;
}
