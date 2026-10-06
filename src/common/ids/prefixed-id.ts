import { monotonicFactory } from 'ulid';

/**
 * Mints one prefixed identifier namespace, e.g. `ava_` for Avatar assets.
 *
 * The timestamp comes from the caller rather than the wall clock so a use case
 * that already takes a `now` does not silently reach past it for its id: a test
 * holding a fixed clock gets ids from that clock, and the id a row is written
 * with carries the same instant as the row's `created_at`.
 *
 * The monotonic factory preserves mint order for calls in this process that
 * share a millisecond. It does not establish order across processes.
 */
export function prefixedIdGenerator(prefix: string): (now: Date) => string {
  const nextId = monotonicFactory();

  return (now: Date): string => `${prefix}${nextId(now.getTime())}`;
}
