import type { FastifyRequest } from 'fastify';

import { AppError } from '@/common/errors/app-error';
import type { RuntimeConfiguration } from '@/config/runtime-configuration';
import {
  type RequestEnvironmentConfig,
  isLocalAuthBypassEnabled,
  resolveAihubEnvironment,
} from './request-environment';

function request(hostname: string): FastifyRequest {
  return { hostname } as FastifyRequest;
}

function configuration(
  overrides: Partial<RequestEnvironmentConfig> = {},
): RequestEnvironmentConfig {
  return {
    NODE_ENV: 'production',
    AIHUB_ALLOW_UNAUTHENTICATED_DEV: false,
    AIHUB_PRODUCTION_HOST: undefined,
    AIHUB_STAGING_HOST: undefined,
    AIHUB_DEVELOPMENT_HOST: undefined,
    AIHUB_SANDBOX_HOST: undefined,
    ...overrides,
  } as RuntimeConfiguration;
}

describe('resolveAihubEnvironment', () => {
  it('resolves the published Production and Sandbox hostnames', () => {
    const config = configuration();

    expect(
      resolveAihubEnvironment(request('api.aihubproduction.com'), config),
    ).toBe('production');
    expect(
      resolveAihubEnvironment(request('sandbox.aihubproduction.com'), config),
    ).toBe('sandbox');
  });

  it('derives all four environments from configured hostnames', () => {
    const config = configuration({
      AIHUB_PRODUCTION_HOST: 'api.acme-real-domain.com',
      AIHUB_STAGING_HOST: 'staging-api.acme-real-domain.com',
      AIHUB_DEVELOPMENT_HOST: 'dev-api.acme-real-domain.com',
      AIHUB_SANDBOX_HOST: 'sandbox.acme-real-domain.com',
    });

    expect(
      resolveAihubEnvironment(request('api.acme-real-domain.com'), config),
    ).toBe('production');
    expect(
      resolveAihubEnvironment(
        request('staging-api.acme-real-domain.com'),
        config,
      ),
    ).toBe('staging');
    expect(
      resolveAihubEnvironment(request('dev-api.acme-real-domain.com'), config),
    ).toBe('development');
    expect(
      resolveAihubEnvironment(request('sandbox.acme-real-domain.com'), config),
    ).toBe('sandbox');
  });

  it('does not map an unset optional host to a placeholder', () => {
    expect(() =>
      resolveAihubEnvironment(
        request('sandbox.aihub.example.com'),
        configuration({ AIHUB_PRODUCTION_HOST: 'api.acme-real-domain.com' }),
      ),
    ).toThrow(AppError);
  });

  it('normalizes configured hostnames before matching', () => {
    expect(
      resolveAihubEnvironment(
        request('api.acme-real-domain.com'),
        configuration({
          AIHUB_PRODUCTION_HOST: ' API.Acme-Real-Domain.com. ',
        }),
      ),
    ).toBe('production');
  });

  it('allows local hostnames only in development and test', () => {
    expect(
      resolveAihubEnvironment(
        request('localhost'),
        configuration({ NODE_ENV: 'development' }),
      ),
    ).toBe('development');
    expect(() =>
      resolveAihubEnvironment(request('localhost'), configuration()),
    ).toThrow(AppError);
  });

  it('fails closed for an unknown public hostname', () => {
    expect(() =>
      resolveAihubEnvironment(
        request('evil.example.com'),
        configuration({ AIHUB_PRODUCTION_HOST: 'api.acme-real-domain.com' }),
      ),
    ).toThrow(AppError);
  });
});

describe('isLocalAuthBypassEnabled', () => {
  it('requires both an explicit local mode and the bypass flag', () => {
    expect(
      isLocalAuthBypassEnabled(
        configuration({
          NODE_ENV: 'development',
          AIHUB_ALLOW_UNAUTHENTICATED_DEV: true,
        }),
      ),
    ).toBe(true);
    expect(
      isLocalAuthBypassEnabled(
        configuration({ AIHUB_ALLOW_UNAUTHENTICATED_DEV: true }),
      ),
    ).toBe(false);
  });
});
