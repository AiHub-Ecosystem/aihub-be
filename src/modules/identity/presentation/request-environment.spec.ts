import type { FastifyRequest } from 'fastify';

import { AppError } from '../../../common/errors/app-error';
import { resolveAihubEnvironment } from './request-environment';

function request(hostname: string): FastifyRequest {
  return { hostname } as FastifyRequest;
}

describe('resolveAihubEnvironment', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('derives production, staging, and development from trusted hostnames', () => {
    process.env.NODE_ENV = 'production';
    expect(resolveAihubEnvironment(request('api.aihub.example.com'))).toBe(
      'production',
    );
    expect(
      resolveAihubEnvironment(request('staging-api.aihub.example.com')),
    ).toBe('staging');
    expect(resolveAihubEnvironment(request('dev-api.aihub.example.com'))).toBe(
      'development',
    );
  });

  it('allows local hostnames only for development and test processes', () => {
    process.env.NODE_ENV = 'development';
    expect(resolveAihubEnvironment(request('localhost'))).toBe('development');

    process.env.NODE_ENV = 'production';
    expect(() => resolveAihubEnvironment(request('localhost'))).toThrow(
      AppError,
    );
  });

  it('fails closed for an unknown public hostname', () => {
    process.env.NODE_ENV = 'production';

    expect(() => resolveAihubEnvironment(request('evil.example.com'))).toThrow(
      AppError,
    );
  });
});
