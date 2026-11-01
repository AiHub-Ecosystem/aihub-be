import { parseWritingV3ProviderError } from './writing-v3-error.adapter';

function providerError(error_code: string, status_code: number) {
  return {
    success: false,
    status_code,
    error_code,
    message: 'provider text that AIHUB must never forward',
    detail: 'same',
    details: null,
  };
}

describe('parseWritingV3ProviderError', () => {
  it('maps the provider timeout to AI_SERVICE_TIMEOUT by body code and by status alone', () => {
    const expected = {
      code: 'AI_SERVICE_TIMEOUT',
      message: 'AI service request timed out',
      retryable: true,
    };

    expect(
      parseWritingV3ProviderError(504, providerError('gateway_timeout', 504)),
    ).toEqual(expected);
    expect(parseWritingV3ProviderError(504, 'not json')).toEqual(expected);
  });

  it.each([
    ['payload_too_large', 413],
    ['image_unreadable', 422],
  ])('maps %s to INVALID_REQUEST without the provider text', (code, status) => {
    const hint = parseWritingV3ProviderError(
      status,
      providerError(code, status),
    );

    expect(hint).toEqual({
      code: 'INVALID_REQUEST',
      message: 'Writing request was refused by the AI service',
      retryable: false,
    });
    expect(hint?.message).not.toContain('provider text');
  });

  it.each([
    ['invalid_request (missing or malformed AIHUB header)', 400],
    ['unauthorized', 401],
    ['rate_limited', 429],
    ['internal_error', 500],
    ['bad_gateway', 502],
    ['something_new', 422],
  ])('leaves %s to the default status mapping', (code, status) => {
    expect(
      parseWritingV3ProviderError(
        status,
        providerError(code.split(' ')[0] ?? code, status),
      ),
    ).toBeUndefined();
  });

  it('ignores a success status and a body that is not a provider error', () => {
    expect(parseWritingV3ProviderError(200, { success: true })).toBeUndefined();
    expect(parseWritingV3ProviderError(413, null)).toBeUndefined();
    expect(parseWritingV3ProviderError(413, { error_code: 7 })).toBeUndefined();
  });
});
