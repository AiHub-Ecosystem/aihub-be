import { contractViolation } from './contract-violation';

// Control characters carry no meaning in plain text a client renders. This
// drops the C0 and C1 controls except tab, line feed and carriage return, which
// feedback legitimately uses, and the bidirectional controls that can make text
// read in a different order than it is stored.
const CONTROL_CHARACTERS = /(?![\t\n\r])\p{Cc}|[‪-‮⁦-⁩]/gu;

/**
 * The deepest nesting a provider body may have. The captured responses nest
 * under ten levels; a body deeper than this is not a grading result, and
 * walking it recursively would exhaust the stack inside the byte limit.
 */
export const MAX_RESPONSE_DEPTH = 64;

function clean(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.replace(CONTROL_CHARACTERS, '');
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (depth >= MAX_RESPONSE_DEPTH) {
    throw contractViolation(
      `response body is nested deeper than ${MAX_RESPONSE_DEPTH} levels`,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => clean(item, depth + 1));
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const cleaned = key.replace(CONTROL_CHARACTERS, '');
    // Two keys that differ only by a control character would silently drop one.
    if (Object.hasOwn(copy, cleaned)) {
      throw contractViolation(
        'response body has keys that are the same once control characters are removed',
      );
    }
    copy[cleaned] = clean(item, depth + 1);
  }
  return copy;
}

/**
 * Refuses a body that holds a string longer than `maxLength`. For a response
 * whose public schema cannot publish a text limit, so the adapter enforces it
 * instead. Run it after `stripControlCharacters`, which bounds the nesting.
 */
export function assertTextWithinLimit(value: unknown, maxLength: number): void {
  if (typeof value === 'string') {
    if (value.length > maxLength) {
      throw contractViolation(`a text field exceeds ${maxLength} units`);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) assertTextWithinLimit(item, maxLength);
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      assertTextWithinLimit(item, maxLength);
    }
  }
}

/**
 * Returns a copy of a provider body with control characters removed from every
 * string and every key it holds. Numbers, booleans and null pass through, so an
 * adapter can clean the whole body once before it reads a single field. A body
 * nested deeper than `MAX_RESPONSE_DEPTH` is a contract violation.
 */
export function stripControlCharacters(value: unknown): unknown {
  return clean(value, 0);
}
