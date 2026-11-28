/**
 * Shared boundary check for stored object keys. Feature-specific prefix rules
 * stay with the feature that owns the objects (ADR-0196).
 */
export function isSafeObjectKey(objectKey: string): boolean {
  return (
    objectKey.length > 0 &&
    objectKey.length <= 1_024 &&
    !objectKey.includes('..') &&
    !/[\s?#]/u.test(objectKey)
  );
}
