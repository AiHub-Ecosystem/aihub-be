import type { FastifyRequest } from 'fastify';

import { AppError } from '../../../common/errors/app-error';

export type AihubEnvironment = 'development' | 'staging' | 'production';

const PUBLIC_HOST_ENVIRONMENTS: Readonly<Record<string, AihubEnvironment>> = {
  'api.aihub.example.com': 'production',
  'staging-api.aihub.example.com': 'staging',
  'dev-api.aihub.example.com': 'development',
};

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

export function resolveAihubEnvironment(
  request: FastifyRequest,
): AihubEnvironment {
  const hostname = request.hostname.trim().toLowerCase().replace(/\.$/, '');
  const publicEnvironment = PUBLIC_HOST_ENVIRONMENTS[hostname];
  if (publicEnvironment !== undefined) {
    return publicEnvironment;
  }

  if (
    LOCAL_HOSTNAMES.has(hostname) &&
    (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')
  ) {
    return 'development';
  }

  throw new AppError({
    code: 'ENVIRONMENT_NOT_ALLOWED',
    message: 'Request host is not bound to an AIHUB environment',
    httpStatus: 403,
    retryable: false,
  });
}

export function isLocalAuthBypassEnabled(): boolean {
  return (
    (process.env.NODE_ENV === 'development' ||
      process.env.NODE_ENV === 'test') &&
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV === 'true'
  );
}
