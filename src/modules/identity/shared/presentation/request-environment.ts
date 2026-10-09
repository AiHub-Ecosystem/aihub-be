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

const ENVIRONMENTS: readonly AihubEnvironment[] = [
  'development',
  'staging',
  'production',
  'sandbox',
];

type HostVariable = Extract<keyof RuntimeConfiguration, `AIHUB_${string}_HOST`>;

const HOST_VARIABLES: Readonly<Record<AihubEnvironment, HostVariable>> = {
  production: 'AIHUB_PRODUCTION_HOST',
  staging: 'AIHUB_STAGING_HOST',
  development: 'AIHUB_DEVELOPMENT_HOST',
  sandbox: 'AIHUB_SANDBOX_HOST',
};

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

export type RequestEnvironmentConfig = Pick<
  RuntimeConfiguration,
  | 'NODE_ENV'
  | 'AIHUB_ALLOW_UNAUTHENTICATED_DEV'
  | 'AIHUB_PRODUCTION_HOST'
  | 'AIHUB_STAGING_HOST'
  | 'AIHUB_DEVELOPMENT_HOST'
  | 'AIHUB_SANDBOX_HOST'
>;

function configuredHosts(
  config: RequestEnvironmentConfig,
): ReadonlyMap<string, AihubEnvironment> {
  const hosts = new Map<string, AihubEnvironment>();
  for (const server of PUBLIC_API_SERVERS) {
    hosts.set(server.hostname, server.environment);
  }
  for (const environment of ENVIRONMENTS) {
    const variable = HOST_VARIABLES[environment];
    const value = config[variable];
    if (value === undefined) continue;
    const hostname = value.trim().toLowerCase().replace(/\.$/, '');
    hosts.set(hostname, environment);
  }
  return hosts;
}

function hostnameFromHostHeader(request: FastifyRequest): string {
  const host = request.headers.host;
  if (host === undefined) return '';

  try {
    return new URL(`http://${host}`).hostname
      .replace(/^\[|\]$/g, '')
      .trim()
      .toLowerCase()
      .replace(/\.$/, '');
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
