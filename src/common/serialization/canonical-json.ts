function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonical JSON cannot contain a non-finite number');
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  // ponytail: accepts JSON-shaped values only. A Date, Map, Set or class
  // instance has no own enumerable keys and serializes as `{}`; callers must
  // convert such values first. Stored idempotency fingerprints and audit
  // cursors are keyed on this exact output, so do not change it in passing.
  if (isRecord(value)) {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) {
        throw new Error('canonical JSON cannot contain undefined');
      }
      normalized[key] = canonicalize(item);
    }
    return normalized;
  }

  throw new Error('canonical JSON contains an unsupported value');
}

/**
 * Byte-stable JSON: object keys sorted recursively, array order kept. The same
 * logical value always yields the same string.
 */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) {
    throw new Error('canonical JSON could not be serialized');
  }
  return serialized;
}
