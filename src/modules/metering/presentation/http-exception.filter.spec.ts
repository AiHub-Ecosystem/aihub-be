import type { ArgumentsHost } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '@/common/errors/app-error';
import { HttpExceptionFilter } from './http-exception.filter';

async function catchRetryHint(
  retryAfterMs: number,
): Promise<{ header: string | undefined; body: unknown; status: jest.Mock }> {
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
      retryAfterMs,
    }),
    host,
  );

  return {
    header: headers.get('Retry-After'),
    body: send.mock.calls[0]?.[0],
    status,
  };
}

describe('HttpExceptionFilter', () => {
  it('emits Retry-After for retryable Argon2 capacity refusals', async () => {
    const { header, body, status } = await catchRetryHint(1000);

    expect(header).toBe('1');
    expect(status).toHaveBeenCalledWith(503);
    expect(body).toMatchObject({
      error: {
        code: 'AUTH_ARGON2_CAPACITY',
        retryable: true,
        retry_after_ms: 1000,
      },
    });
  });

  it('rounds a valid hint up to whole seconds in the header', async () => {
    const { header, body } = await catchRetryHint(1_001);

    expect(header).toBe('2');
    expect(body).toMatchObject({ error: { retry_after_ms: 1_001 } });
  });

  it.each([
    ['negative', -1],
    ['fractional', 1_500.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])(
    'omits both header and body hint when the hint is %s',
    async (_kind, retryAfterMs) => {
      const { header, body } = await catchRetryHint(retryAfterMs);

      expect(header).toBeUndefined();
      expect(body).toMatchObject({ error: { retryable: true } });
      expect(body).not.toHaveProperty('error.retry_after_ms');
    },
  );
});
