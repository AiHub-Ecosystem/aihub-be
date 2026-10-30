import {
  type ArgumentsHost,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { PublicApiMajorDef } from '@/catalog/public-api-majors';
import { AppError } from '@/common/errors/app-error';
import { retiredPublicApiMajor } from '@/common/http/retired-public-api-major';
import { HttpExceptionFilter } from './http-exception.filter';

interface Caught {
  readonly header: string | undefined;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: unknown;
  readonly status: jest.Mock;
}

async function catchException(
  exception: unknown,
  url = '/v1/auth/login',
  configure: (filter: HttpExceptionFilter) => void = () => undefined,
): Promise<Caught> {
  const request = {
    id: 'invalid-request-id',
    url,
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
  configure(filter);

  await filter.catch(exception, host);

  return {
    header: headers.get('Retry-After'),
    headers,
    body: send.mock.calls[0]?.[0],
    status,
  };
}

function catchRetryHint(retryAfterMs: number): Promise<Caught> {
  return catchException(
    new AppError({
      code: 'AUTH_ARGON2_CAPACITY',
      message: 'Authentication capacity is temporarily unavailable',
      retryable: true,
      retryAfterMs,
    }),
  );
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

describe('HttpExceptionFilter for a method the route does not accept', () => {
  it('answers a framework 405 as NOT_FOUND, without an Allow header', async () => {
    const { status, body, headers } = await catchException(
      new HttpException('Method Not Allowed', 405),
      '/v1/organizations/me/members',
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(body).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
    });
    expect(headers.has('Allow')).toBe(false);
  });
});

describe('HttpExceptionFilter for a retired Public API major', () => {
  const MAJORS: readonly PublicApiMajorDef[] = [
    {
      major: 1,
      contractVersion: '1.4.0',
      status: 'retired',
      releasedAt: '2026-10-27',
      sunset: {
        successor: 2,
        deprecationAt: '2027-01-01T00:00:00Z',
        sunsetAt: '2028-01-01T00:00:00Z',
      },
    },
    {
      major: 2,
      contractVersion: '2.0.0',
      status: 'supported',
      releasedAt: '2027-01-01',
    },
  ];
  const withRegistry = (filter: HttpExceptionFilter): void => {
    filter.retiredMajor = (url) => retiredPublicApiMajor(url, MAJORS);
  };

  it.each([
    ['a dispatch route', OPERATION_CATALOG['writing.task1.grade'].path],
    ['a non-dispatch route', '/v1/organizations/org_1/members?limit=5'],
    ['an unknown path under the major', '/v1/never-existed'],
    ['the bare major', '/v1'],
  ])('answers %s with 410 and the successor', async (_kind, url) => {
    const { body, status, headers } = await catchException(
      new NotFoundException(),
      url,
      withRegistry,
    );

    expect(status).toHaveBeenCalledWith(410);
    expect(body).toEqual({
      error: {
        code: 'API_VERSION_RETIRED',
        message: 'API version v1 is retired; use v2',
        request_id: 'unknown',
        retryable: false,
        details: {
          retired_major: 'v1',
          successor_major: 'v2',
          successor_docs: '/docs?version=v2',
        },
      },
    });
    expect(headers.get('Link')).toBe(
      '</docs?version=v2>; rel="successor-version"; title="v2"',
    );
    expect(headers.get('Retry-After')).toBeUndefined();
  });

  it.each([
    ['a supported major', '/v2/missing'],
    ['a look-alike prefix', '/v10/missing'],
    ['an unversioned path', '/missing'],
  ])('keeps 404 for %s', async (_kind, url) => {
    const { status } = await catchException(
      new NotFoundException(),
      url,
      withRegistry,
    );

    expect(status).toHaveBeenCalledWith(404);
  });

  it('leaves an application NOT_FOUND under a retired major alone', async () => {
    const { status } = await catchException(
      new AppError({
        code: 'NOT_FOUND',
        message: 'Resource not found',
        retryable: false,
      }),
      '/v1/organizations/org_1',
      withRegistry,
    );

    expect(status).toHaveBeenCalledWith(404);
  });
});
