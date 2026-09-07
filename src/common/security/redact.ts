const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = new Set([
  'api_key',
  'api-key',
  'x-api-key',
  'authorization',
  'user_assertion',
  'x-user-assertion',
  'internal_token',
  'essay',
  'body',
]);

export function redactRecord(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    output[key] = SENSITIVE_KEYS.has(key.toLowerCase())
      ? REDACTED
      : redactValue(value);
  }

  return output;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
