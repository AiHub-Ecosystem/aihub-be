/**
 * The one meaning of "a plain object": a non-null object that is not an array.
 * An array is excluded because every caller reads named members from the
 * value, and an array has none worth reading. Code that must accept arrays
 * says `Array.isArray` beside this call.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
