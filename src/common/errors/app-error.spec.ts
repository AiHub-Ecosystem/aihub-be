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
        details: { operation: 'writing.task1.grade' },
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
      },
    });
  });
});
