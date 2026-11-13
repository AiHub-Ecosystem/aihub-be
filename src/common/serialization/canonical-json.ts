import { internalError } from '@/common/errors/app-error';
import { isRecord } from '@/common/is-record';

function serialize(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw internalError('canonical JSON cannot contain a non-finite number');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${Array.from(value, (item) => serialize(item)).join(',')}]`;
  }

  // ponytail: accepts JSON-shaped values only. A Date, Map, Set or class
  // instance has no own enumerable keys and serializes as `{}`; callers must
  // convert such values first. Stored idempotency fingerprints and cursors are
  // keyed on this exact output (ADR-0164), so do not change it in passing.
  if (isRecord(value)) {
    // The text is built member by member, never through an intermediate
    // object: a JS object lists integer-like keys first whatever order they
    // were inserted in, which would break RFC 8785 ordering, and assigning
    // `output['__proto__']` would call the prototype setter and drop the key.
    // `.sort()` compares UTF-16 code units, which is the order RFC 8785 sets.
    const members = Object.keys(value)
      .sort()
      .map((key) => {
        const item = value[key];
        if (item === undefined) {
          throw internalError('canonical JSON cannot contain undefined');
        }
        return `${JSON.stringify(key)}:${serialize(item)}`;
      });
    return `{${members.join(',')}}`;
  }

  throw internalError('canonical JSON contains an unsupported value');
}

/**
 * Byte-stable JSON in RFC 8785 (JCS) key order: object keys sorted recursively
 * by UTF-16 code units, array order kept. The same logical value always yields
 * the same string.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}
