/**
 * A NUL character, or half of a UTF-16 surrogate pair standing alone. Neither
 * survives PostgreSQL: a NUL cannot be stored or compared in text (SQLSTATE
 * 22021), and a lone surrogate fails a jsonb write (SQLSTATE 22P02) and is
 * silently replaced by U+FFFD in a text column. Both arrive legally in JSON as
 * `\u0000` or `\ud800`.
 */
function isUnstorable(text: string): boolean {
  // In `u` mode a well-formed pair reads as one code point, so `Cs` matches
  // only a surrogate that stands alone.
  return text.includes('\u0000') || /\p{Cs}/u.test(text);
}

/**
 * Whether a decoded request value holds text PostgreSQL cannot store as sent,
 * in any string including object keys, so such input is refused as invalid at
 * the boundary rather than reaching a query and surfacing as a server error or
 * as a stored value that differs from the one sent.
 */
export function containsUnstorableText(value: unknown): boolean {
  if (typeof value === 'string') return isUnstorable(value);
  if (Array.isArray(value)) return value.some(containsUnstorableText);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(
      ([key, entry]) => isUnstorable(key) || containsUnstorableText(entry),
    );
  }
  return false;
}
