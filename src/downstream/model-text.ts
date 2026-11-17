// Control characters carry no meaning in plain text a client renders. This
// drops the C0 and C1 controls except tab, line feed and carriage return, which
// feedback legitimately uses, and the bidirectional controls that can make text
// read in a different order than it is stored.
const CONTROL_CHARACTERS = /(?![\t\n\r])\p{Cc}|[‪-‮⁦-⁩]/gu;

/**
 * Returns a copy of a provider body with control characters removed from every
 * string it holds. Keys, numbers, booleans and null pass through unchanged, so
 * an adapter can clean the whole body once before it reads a single field.
 */
export function stripControlCharacters(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(CONTROL_CHARACTERS, '');
  }
  if (Array.isArray(value)) {
    return value.map(stripControlCharacters);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        stripControlCharacters(item),
      ]),
    );
  }
  return value;
}
