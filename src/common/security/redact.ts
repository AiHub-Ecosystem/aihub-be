import { isRecord } from '@/common/is-record';
const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = new Set([
  'api_key',
  'api-key',
  'x-api-key',
  'authorization',
  'user_assertion',
  'x-user-identity',
  // Retired header name. Unmigrated clients still send a signed JWT in it,
  // so it stays redacted even though AIHUB no longer reads it.
  'x-user-assertion',
  'internal_token',
  'essay',
  'body',
]);

export function redactRecord(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  // `Object.fromEntries` defines own data properties, so a `__proto__` key is
  // kept; assigning `output[key]` would call the prototype setter and drop it.
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redactValue(value),
    ]),
  );
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (isRecord(value)) {
    return redactRecord(value);
  }

  return value;
}
