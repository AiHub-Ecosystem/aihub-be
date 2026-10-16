/**
 * Whether a decoded request value holds a NUL character in any string,
 * including object keys. PostgreSQL cannot store or compare a NUL in text
 * (SQLSTATE 22021), so such input is refused as invalid at the boundary rather
 * than reaching a query and surfacing as a server error.
 */
export function containsNulCharacter(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(containsNulCharacter);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(
      ([key, entry]) => key.includes('\u0000') || containsNulCharacter(entry),
    );
  }
  return false;
}
