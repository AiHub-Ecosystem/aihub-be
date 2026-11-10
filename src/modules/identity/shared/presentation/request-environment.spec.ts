import type { FastifyRequest } from 'fastify';

import { AppError } from '@/common/errors/app-error';
import type { RuntimeConfiguration } from '@/config/runtime-configuration';
import {
  type RequestEnvironmentConfig,
  isLocalAuthBypassEnabled,
  resolveAihubEnvironment,
} from './request-environment';

function request(hostname: string, hostHeader = hostname): FastifyRequest {
  return { hostname, headers: { host: hostHeader } } as FastifyRequest;
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
    AIHUB_RUNTIME_DATABASE_SCOPE: 'production',
    ...overrides,
  } as RuntimeConfiguration;
}

describe('resolveAihubEnvironment', () => {
  it('resolves the published Production and Sandbox hostnames', () => {
    expect(
      resolveAihubEnvironment(
        request('api.aihubproduction.com'),
        configuration(),
      ),
    ).toBe('production');
    expect(
      resolveAihubEnvironment(
        request('sandbox.aihubproduction.com'),
        configuration({ AIHUB_RUNTIME_DATABASE_SCOPE: 'sandbox' }),
      ),
    ).toBe('sandbox');
  });

  it('refuses cross-environment hostnames before authentication', () => {
    const productionConfig = configuration();
    const sandboxConfig = configuration({
      AIHUB_RUNTIME_DATABASE_SCOPE: 'sandbox',
      AIHUB_PRODUCTION_HOST: 'api.acme.test',
      AIHUB_SANDBOX_HOST: 'sandbox.acme.test',
    });

    // Production process rejects Sandbox hosts
    expect(() =>
      resolveAihubEnvironment(
        request('sandbox.aihubproduction.com'),
        productionConfig,
      ),
    ).toThrow(AppError);
    expect(() =>
      resolveAihubEnvironment(request('sandbox.acme.test'), productionConfig),
    ).toThrow(AppError);

    // Sandbox process rejects Production hosts
    expect(() =>
      resolveAihubEnvironment(
        request('api.aihubproduction.com'),
        sandboxConfig,
      ),
    ).toThrow(AppError);
    expect(() =>
      resolveAihubEnvironment(request('api.acme.test'), sandboxConfig),
    ).toThrow(AppError);
  });

  it('uses the routed Host header instead of a forwarded hostname', () => {
    expect(
      resolveAihubEnvironment(
        request('sandbox.aihubproduction.com', 'api.aihubproduction.com:443'),
        configuration(),
      ),
    ).toBe('production');
  });

  it('derives all four environments from configured hostnames', () => {
    const config = configuration({
      AIHUB_PRODUCTION_HOST: 'api.acme-real-domain.com',
      AIHUB_STAGING_HOST: 'staging-api.acme-real-domain.com',
      AIHUB_DEVELOPMENT_HOST: 'dev-api.acme-real-domain.com',
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
      resolveAihubEnvironment(
        request('sandbox.acme-real-domain.com'),
        configuration({
          AIHUB_RUNTIME_DATABASE_SCOPE: 'sandbox',
          AIHUB_SANDBOX_HOST: 'sandbox.acme-real-domain.com',
        }),
      ),
    ).toBe('sandbox');
  });

  it('does not map an unset optional host to a placeholder', () => {
    expect(() =>
      resolveAihubEnvironment(
        request('sandbox.aihub.example.com'),
        configuration({
          AIHUB_RUNTIME_DATABASE_SCOPE: 'sandbox',
          AIHUB_PRODUCTION_HOST: 'api.acme-real-domain.com',
        }),
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
    // Sandbox process never allows localhost even in dev
    expect(() =>
      resolveAihubEnvironment(
        request('localhost'),
        configuration({
          NODE_ENV: 'development',
          AIHUB_RUNTIME_DATABASE_SCOPE: 'sandbox',
        }),
      ),
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
