import type { FastifyRequest } from 'fastify';

import { AppError } from '../../../common/errors/app-error';
import {
  assertAuthBypassFlagIsSafe,
  assertHostConfigurationIsSafe,
  resolveAihubEnvironment,
} from './request-environment';

function request(hostname: string): FastifyRequest {
  return { hostname } as FastifyRequest;
}

describe('resolveAihubEnvironment', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalProductionHost = process.env.AIHUB_PRODUCTION_HOST;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalProductionHost === undefined) {
      Reflect.deleteProperty(process.env, 'AIHUB_PRODUCTION_HOST');
    } else {
      process.env.AIHUB_PRODUCTION_HOST = originalProductionHost;
    }
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

  it('honours a configured production hostname instead of the placeholder', () => {
    process.env.NODE_ENV = 'production';
    process.env.AIHUB_PRODUCTION_HOST = 'api.acme-real-domain.com';

    expect(resolveAihubEnvironment(request('api.acme-real-domain.com'))).toBe(
      'production',
    );
    // The placeholder is no longer trusted once a real host is configured.
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
  const HOST_VARS = [
    'AIHUB_PRODUCTION_HOST',
    'AIHUB_STAGING_HOST',
    'AIHUB_DEVELOPMENT_HOST',
  ] as const;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalHosts = Object.fromEntries(
    HOST_VARS.map((name) => [name, process.env[name]]),
  );

  function setAllHostsToRealDomains(): void {
    process.env.AIHUB_PRODUCTION_HOST = 'api.acme-real-domain.com';
    process.env.AIHUB_STAGING_HOST = 'staging-api.acme-real-domain.com';
    process.env.AIHUB_DEVELOPMENT_HOST = 'dev-api.acme-real-domain.com';
  }

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    for (const name of HOST_VARS) {
      const original = originalHosts[name];
      if (original === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = original;
      }
    }
  });

  it('refuses to start outside development/test when production host is still the placeholder', () => {
    process.env.NODE_ENV = 'production';
    setAllHostsToRealDomains();
    Reflect.deleteProperty(process.env, 'AIHUB_PRODUCTION_HOST');

    expect(() => assertHostConfigurationIsSafe()).toThrow(
      /AIHUB_PRODUCTION_HOST/,
    );
  });

  it('refuses to start when staging host is still the placeholder', () => {
    process.env.NODE_ENV = 'production';
    setAllHostsToRealDomains();
    Reflect.deleteProperty(process.env, 'AIHUB_STAGING_HOST');

    expect(() => assertHostConfigurationIsSafe()).toThrow(/AIHUB_STAGING_HOST/);
  });

  it('refuses to start when development host is still the placeholder — same spoofing risk as prod/staging', () => {
    process.env.NODE_ENV = 'production';
    setAllHostsToRealDomains();
    Reflect.deleteProperty(process.env, 'AIHUB_DEVELOPMENT_HOST');

    expect(() => assertHostConfigurationIsSafe()).toThrow(
      /AIHUB_DEVELOPMENT_HOST/,
    );
  });

  it('names every unconfigured host in one failure', () => {
    process.env.NODE_ENV = 'production';
    for (const name of HOST_VARS) {
      Reflect.deleteProperty(process.env, name);
    }

    expect(() => assertHostConfigurationIsSafe()).toThrow(
      /AIHUB_PRODUCTION_HOST.*AIHUB_STAGING_HOST.*AIHUB_DEVELOPMENT_HOST/s,
    );
  });

  it('allows boot once all three hosts are configured to real domains', () => {
    process.env.NODE_ENV = 'production';
    setAllHostsToRealDomains();

    expect(() => assertHostConfigurationIsSafe()).not.toThrow();
  });

  it('does not check host configuration in development or test', () => {
    process.env.NODE_ENV = 'development';
    for (const name of HOST_VARS) {
      Reflect.deleteProperty(process.env, name);
    }

    expect(() => assertHostConfigurationIsSafe()).not.toThrow();
  });
});
