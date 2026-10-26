import type { ArgumentsHost } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '@/common/errors/app-error';
import { HttpExceptionFilter } from './http-exception.filter';

describe('HttpExceptionFilter', () => {
  it('emits Retry-After for retryable Argon2 capacity refusals', async () => {
    const request = {
      id: 'invalid-request-id',
      raw: {},
    } as unknown as FastifyRequest;
    const headers = new Map<string, string>();
    const status = jest.fn(function (this: unknown) {
      return this;
    });
    const send = jest.fn<void, [unknown]>();
    const response = {
      header(name: string, value: string) {
        headers.set(name, value);
        return this;
      },
      status,
      send,
      elapsedTime: 0,
    } as unknown as FastifyReply;
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;
    const filter = new HttpExceptionFilter({
      finalize: jest.fn().mockResolvedValue(undefined),
    });

    await filter.catch(
      new AppError({
        code: 'AUTH_ARGON2_CAPACITY',
        message: 'Authentication capacity is temporarily unavailable',
        retryable: true,
        retryAfterMs: 1000,
      }),
      host,
    );

    expect(headers.get('Retry-After')).toBe('1');
    expect(status).toHaveBeenCalledWith(503);
    const responseBody: unknown = send.mock.calls[0]?.[0];
    expect(responseBody).toMatchObject({
      error: {
        code: 'AUTH_ARGON2_CAPACITY',
        retryable: true,
        retry_after_ms: 1000,
      },
    });
  });
});
