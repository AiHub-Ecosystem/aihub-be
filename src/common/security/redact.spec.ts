import { redactRecord } from './redact';

describe('redactRecord', () => {
  it('redacts sensitive fields recursively without mutating input', () => {
    const input = {
      api_key: 'aihub_sk_secret',
      operation: 'writing.task1.grade',
      nested: {
        essay: 'private essay',
        safe: 'keep me',
      },
      items: [{ authorization: 'Bearer secret' }],
    };

    const result = redactRecord(input);

    expect(result).toEqual({
      api_key: '[REDACTED]',
      operation: 'writing.task1.grade',
      nested: {
        essay: '[REDACTED]',
        safe: 'keep me',
      },
      items: [{ authorization: '[REDACTED]' }],
    });
    expect(input.api_key).toBe('aihub_sk_secret');
    expect(input.nested.essay).toBe('private essay');
  });

  // Shrunk counterexample from redact.property.spec.ts (#329).
  it('keeps a __proto__ key instead of dropping it', () => {
    const entries: [string, unknown][] = [
      ['__proto__', []],
      ['api_key', 's'],
    ];
    const result = redactRecord(Object.fromEntries(entries));

    expect(Object.keys(result)).toEqual(['__proto__', 'api_key']);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result['api_key']).toBe('[REDACTED]');
  });

  it('redacts the user identity header and the retired assertion header', () => {
    expect(
      redactRecord({
        headers: {
          'X-User-Identity': 'student@example.com',
          'x-user-assertion': 'eyJhbGciOiJSUzI1NiJ9.payload.signature',
        },
      }),
    ).toEqual({
      headers: {
        'X-User-Identity': '[REDACTED]',
        'x-user-assertion': '[REDACTED]',
      },
    });
  });
});
