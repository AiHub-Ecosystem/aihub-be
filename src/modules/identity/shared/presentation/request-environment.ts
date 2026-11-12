import type { FastifyRequest } from 'fastify';

import { AppError } from '@/common/errors/app-error';
import {
  PUBLIC_API_SERVERS,
  type RuntimeConfiguration,
} from '@/config/runtime-configuration';

export type AihubEnvironment =
  | 'development'
  | 'staging'
  | 'production'
  | 'sandbox';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}

export type RequestEnvironmentConfig = Pick<
  RuntimeConfiguration,
  | 'NODE_ENV'
  | 'AIHUB_ALLOW_UNAUTHENTICATED_DEV'
  | 'AIHUB_RUNTIME_DATABASE_SCOPE'
  | 'AIHUB_PRODUCTION_HOST'
  | 'AIHUB_STAGING_HOST'
  | 'AIHUB_DEVELOPMENT_HOST'
  | 'AIHUB_SANDBOX_HOST'
>;

function configuredHosts(
  config: RequestEnvironmentConfig,
): ReadonlyMap<string, AihubEnvironment> {
  const scope = config.AIHUB_RUNTIME_DATABASE_SCOPE;
  const hosts = new Map<string, AihubEnvironment>();

  if (scope === 'sandbox') {
    for (const server of PUBLIC_API_SERVERS) {
      if (server.environment === 'sandbox') {
        hosts.set(server.hostname, server.environment);
      }
    }
    const sandboxHost = config.AIHUB_SANDBOX_HOST;
    if (sandboxHost !== undefined) {
      const hostname = normalizeHostname(sandboxHost);
      if (hostname.length > 0) {
        hosts.set(hostname, 'sandbox');
      }
    }
    return hosts;
  }

  for (const server of PUBLIC_API_SERVERS) {
    if (server.environment === 'production') {
      hosts.set(server.hostname, server.environment);
    }
  }
  const productionHost = config.AIHUB_PRODUCTION_HOST;
  if (productionHost !== undefined) {
    const hostname = normalizeHostname(productionHost);
    if (hostname.length > 0) {
      hosts.set(hostname, 'production');
    }
  }
  const stagingHost = config.AIHUB_STAGING_HOST;
  if (stagingHost !== undefined) {
    const hostname = normalizeHostname(stagingHost);
    if (hostname.length > 0) {
      hosts.set(hostname, 'staging');
    }
  }
  const devHost = config.AIHUB_DEVELOPMENT_HOST;
  if (devHost !== undefined) {
    const hostname = normalizeHostname(devHost);
    if (hostname.length > 0) {
      hosts.set(hostname, 'development');
    }
  }
  return hosts;
}

function hostnameFromHostHeader(request: FastifyRequest): string {
  const host = request.headers.host;
  if (host === undefined) return '';

  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
    return normalizeHostname(hostname);
  } catch {
    return '';
  }
}

export function resolveAihubEnvironment(
  request: FastifyRequest,
  config: RequestEnvironmentConfig,
): AihubEnvironment {
  const hostname = hostnameFromHostHeader(request);
  const publicEnvironment = configuredHosts(config).get(hostname);
  if (publicEnvironment !== undefined) return publicEnvironment;

  if (
    config.AIHUB_RUNTIME_DATABASE_SCOPE === 'production' &&
    LOCAL_HOSTNAMES.has(hostname) &&
    (config.NODE_ENV === 'development' || config.NODE_ENV === 'test')
  ) {
    return 'development';
  }

  throw new AppError({
    code: 'ENVIRONMENT_NOT_ALLOWED',
    message: 'Request host is not bound to an AIHUB environment',
    retryable: false,
  });
}

export function isLocalAuthBypassEnabled(
  config: RequestEnvironmentConfig,
): boolean {
  return (
    (config.NODE_ENV === 'development' || config.NODE_ENV === 'test') &&
    config.AIHUB_ALLOW_UNAUTHENTICATED_DEV
  );
}
