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
