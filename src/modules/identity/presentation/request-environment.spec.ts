import type { FastifyRequest } from 'fastify';

import { AppError } from '../../../common/errors/app-error';
import {
  assertAuthBypassFlagIsSafe,
  assertHostConfigurationIsSafe,
  resolveAihubEnvironment,
} from './request-environment';

const HOST_VARS = [
  'AIHUB_PRODUCTION_HOST',
  'AIHUB_STAGING_HOST',
  'AIHUB_DEVELOPMENT_HOST',
  'AIHUB_SANDBOX_HOST',
] as const;

function request(hostname: string): FastifyRequest {
  return { hostname } as FastifyRequest;
}

function snapshotHosts(): Record<string, string | undefined> {
  return Object.fromEntries(HOST_VARS.map((name) => [name, process.env[name]]));
}

function restoreHosts(originalHosts: Record<string, string | undefined>): void {
  for (const name of HOST_VARS) {
    const original = originalHosts[name];
    if (original === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = original;
    }
  }
}

function clearHosts(): void {
  for (const name of HOST_VARS) {
    Reflect.deleteProperty(process.env, name);
  }
}

function setProductionHost(): void {
  process.env.AIHUB_PRODUCTION_HOST = 'api.acme-real-domain.com';
}

function setAllHostsToRealDomains(): void {
  process.env.AIHUB_PRODUCTION_HOST = 'api.acme-real-domain.com';
  process.env.AIHUB_STAGING_HOST = 'staging-api.acme-real-domain.com';
  process.env.AIHUB_DEVELOPMENT_HOST = 'dev-api.acme-real-domain.com';
  process.env.AIHUB_SANDBOX_HOST = 'sandbox.acme-real-domain.com';
}

describe('resolveAihubEnvironment', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalHosts = snapshotHosts();

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    restoreHosts(originalHosts);
  });

  it('derives all four environments from configured hostnames', () => {
    process.env.NODE_ENV = 'production';
    setAllHostsToRealDomains();

    expect(resolveAihubEnvironment(request('api.acme-real-domain.com'))).toBe(
      'production',
    );
    expect(
      resolveAihubEnvironment(request('staging-api.acme-real-domain.com')),
    ).toBe('staging');
    expect(
      resolveAihubEnvironment(request('dev-api.acme-real-domain.com')),
    ).toBe('development');
    expect(
      resolveAihubEnvironment(request('sandbox.acme-real-domain.com')),
    ).toBe('sandbox');
  });

  it('does not map an unset optional host to a placeholder', () => {
    process.env.NODE_ENV = 'production';
    setProductionHost();

    expect(() =>
      resolveAihubEnvironment(request('sandbox.aihub.example.com')),
    ).toThrow(AppError);
  });

  it('normalizes configured hostnames before matching', () => {
    process.env.NODE_ENV = 'production';
    process.env.AIHUB_PRODUCTION_HOST = ' API.Acme-Real-Domain.com. ';

    expect(resolveAihubEnvironment(request('api.acme-real-domain.com'))).toBe(
      'production',
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
    setProductionHost();

    expect(() => resolveAihubEnvironment(request('evil.example.com'))).toThrow(
      AppError,
    );
  });

  it('does not trust the placeholder after a real host is configured', () => {
    process.env.NODE_ENV = 'production';
    setProductionHost();

    expect(() =>
      resolveAihubEnvironment(request('api.aihub.example.com')),
    ).toThrow(AppError);
  });
});

describe('assertAuthBypassFlagIsSafe', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBypassFlag = process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalBypassFlag === undefined) {
      Reflect.deleteProperty(process.env, 'AIHUB_ALLOW_UNAUTHENTICATED_DEV');
    } else {
      process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = originalBypassFlag;
    }
  });

  it('refuses to start when the bypass flag is set outside development or test', () => {
    process.env.NODE_ENV = 'production';
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'true';

    expect(() => assertAuthBypassFlagIsSafe()).toThrow(
      /has no effect outside development or test/,
    );
  });

  it('refuses to start when the bypass flag is set and NODE_ENV is unset', () => {
    Reflect.deleteProperty(process.env, 'NODE_ENV');
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'true';

    expect(() => assertAuthBypassFlagIsSafe()).toThrow();
  });

  it('allows the bypass flag in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'true';

    expect(() => assertAuthBypassFlagIsSafe()).not.toThrow();
  });

  it('is a no-op when the bypass flag is unset, regardless of environment', () => {
    process.env.NODE_ENV = 'production';
    Reflect.deleteProperty(process.env, 'AIHUB_ALLOW_UNAUTHENTICATED_DEV');

    expect(() => assertAuthBypassFlagIsSafe()).not.toThrow();
  });
});

describe('assertHostConfigurationIsSafe', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalHosts = snapshotHosts();

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    restoreHosts(originalHosts);
  });

  it('requires only the production host outside development/test', () => {
    process.env.NODE_ENV = 'production';
    clearHosts();

    expect(() => assertHostConfigurationIsSafe()).toThrow(
      /AIHUB_PRODUCTION_HOST/,
    );
    expect(() => assertHostConfigurationIsSafe()).not.toThrow(/STAGING_HOST/);
  });

  it('rejects a production placeholder outside development/test', () => {
    process.env.NODE_ENV = 'production';
    clearHosts();
    process.env.AIHUB_PRODUCTION_HOST = 'api.aihub.example.com';

    expect(() => assertHostConfigurationIsSafe()).toThrow(
      /AIHUB_PRODUCTION_HOST/,
    );
  });

  it('allows optional tiers to be absent and accepts sandbox when configured', () => {
    process.env.NODE_ENV = 'production';
    clearHosts();
    setProductionHost();
    process.env.AIHUB_SANDBOX_HOST = 'sandbox.acme-real-domain.com';

    expect(() => assertHostConfigurationIsSafe()).not.toThrow();
  });

  it('rejects duplicate normalized hosts', () => {
    process.env.NODE_ENV = 'production';
    clearHosts();
    setProductionHost();
    process.env.AIHUB_SANDBOX_HOST = ' API.ACME-REAL-DOMAIN.COM. ';

    expect(() => assertHostConfigurationIsSafe()).toThrow(
      /same hostname as AIHUB_PRODUCTION_HOST/,
    );
  });

  it.each([
    ['wildcard', '*.acme-real-domain.com'],
    ['URL', 'https://api.acme-real-domain.com/path'],
    ['port', 'api.acme-real-domain.com:443'],
  ])('rejects a malformed %s host', (_label, value) => {
    process.env.NODE_ENV = 'production';
    clearHosts();
    process.env.AIHUB_PRODUCTION_HOST = value;

    expect(() => assertHostConfigurationIsSafe()).toThrow(
      /AIHUB_PRODUCTION_HOST/,
    );
  });

  it('does not require public hosts in development or test', () => {
    process.env.NODE_ENV = 'development';
    clearHosts();

    expect(() => assertHostConfigurationIsSafe()).not.toThrow();
  });
});
