import { AppError } from './app-error';

describe('AppError', () => {
  it('serializes only the public error envelope', () => {
    const error = new AppError({
      code: 'AI_SERVICE_ERROR',
      message: 'The AI service failed',
      httpStatus: 502,
      retryable: true,
      details: { operation: 'writing.task1.grade' },
      cause: new Error('private downstream body'),
    });

    expect(error.toEnvelope('req-123')).toEqual({
      error: {
        code: 'AI_SERVICE_ERROR',
        message: 'The AI service failed',
        request_id: 'req-123',
        retryable: true,
        details: { operation: 'writing.task1.grade' },
      },
    });
  });

  it('serializes a retry hint at the top level and removes its legacy details key', () => {
    const error = new AppError({
      code: 'RATE_LIMITED',
      message: 'Rate limit exceeded',
      httpStatus: 429,
      retryable: true,
      retryAfterMs: 12_345,
      details: { operation: 'writing.task1.grade', retry_after_ms: 999 },
    });

    expect(error.toEnvelope('req-789')).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded',
        request_id: 'req-789',
        retryable: true,
        retry_after_ms: 12_345,
        details: { operation: 'writing.task1.grade' },
      },
    });
  });

  it('serializes non-retryable errors with retryable false and no retry hint', () => {
    const error = new AppError({
      code: 'INVALID_REQUEST',
      message: 'Request failed validation',
      httpStatus: 400,
      retryable: false,
    });

    expect(error.toEnvelope('req-000')).toEqual({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Request failed validation',
        request_id: 'req-000',
        retryable: false,
      },
    });
  });

  it('uses a safe envelope for an unknown error', () => {
    const error = new Error('private stack and body');

    expect(AppError.toEnvelope(error, 'req-456')).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        request_id: 'req-456',
        retryable: false,
      },
    });
  });
});
