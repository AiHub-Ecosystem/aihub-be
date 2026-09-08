import type { FastifyRequest } from 'fastify';

import { AppError } from '../../../common/errors/app-error';

export type AihubEnvironment = 'development' | 'staging' | 'production';

// Placeholder hostnames, used only when the corresponding env var is unset.
// A real deployment must set AIHUB_PRODUCTION_HOST (and friends) explicitly —
// this mapping decides production vs. staging, so it must never be silently
// wrong for a real domain.
const DEFAULT_HOSTS: Readonly<Record<AihubEnvironment, string>> = {
  production: 'api.aihub.example.com',
  staging: 'staging-api.aihub.example.com',
  development: 'dev-api.aihub.example.com',
};

function configuredHost(environment: AihubEnvironment): string {
  const envVar = `AIHUB_${environment.toUpperCase()}_HOST`;
  const value = process.env[envVar];
  return value !== undefined && value.trim().length > 0
    ? value.trim().toLowerCase()
    : DEFAULT_HOSTS[environment];
}

function publicHostEnvironments(): ReadonlyMap<string, AihubEnvironment> {
  return new Map(
    (Object.keys(DEFAULT_HOSTS) as AihubEnvironment[]).map((environment) => [
      configuredHost(environment),
      environment,
    ]),
  );
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

export function resolveAihubEnvironment(
  request: FastifyRequest,
): AihubEnvironment {
  const hostname = request.hostname.trim().toLowerCase().replace(/\.$/, '');
  const publicEnvironment = publicHostEnvironments().get(hostname);
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
    retryable: false,
  });
}

function isDevOrTestProcess(): boolean {
  return (
    process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
  );
}

export function isLocalAuthBypassEnabled(): boolean {
  return (
    isDevOrTestProcess() &&
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV === 'true'
  );
}

/**
 * `AIHUB_ALLOW_UNAUTHENTICATED_DEV=true` outside development or test has no
 * effect — `isLocalAuthBypassEnabled` already gates on `NODE_ENV` — but
 * without this check, an operator who sets it in a misconfigured production
 * environment gets no signal that the flag they set is dead. Refusing to
 * boot turns that silent no-op into a loud, immediate failure instead of a
 * false sense of having a bypass available.
 */
export function assertAuthBypassFlagIsSafe(): void {
  const bypassRequested =
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV === 'true';

  if (bypassRequested && !isDevOrTestProcess()) {
    throw new Error(
      `AIHUB_ALLOW_UNAUTHENTICATED_DEV=true has no effect outside development or test (NODE_ENV=${JSON.stringify(process.env.NODE_ENV)}). Refusing to start rather than run with a bypass flag that silently does nothing.`,
    );
  }
}

/**
 * `resolveAihubEnvironment` trusts the client-supplied `Host` header — a
 * deployment is only as safe as the reverse proxy in front of it validating
 * or rewriting that header to match its own bound domain (see the security
 * spec). This guard catches the other half of the problem, the one code
 * *can* enforce: a placeholder host left unconfigured is a public, guessable
 * value — `curl -H "Host: staging-api.aihub.example.com" https://<real prod
 * ip>/...` would resolve as staging on a box that never configured a real
 * staging domain. Refusing to boot turns that silent gap into a loud,
 * immediate failure instead of a spoofable default.
 *
 * All three tiers are checked, not just production and staging: the
 * identical risk applies to `AIHUB_DEVELOPMENT_HOST` for any deployment that
 * exposes it publicly, and the `localhost` bypass in `resolveAihubEnvironment`
 * doesn't cover that case — it checks the literal hostname, not this env var.
 */
export function assertHostConfigurationIsSafe(): void {
  if (isDevOrTestProcess()) {
    return;
  }

  const unconfigured = (
    Object.keys(DEFAULT_HOSTS) as AihubEnvironment[]
  ).filter(
    (environment) => configuredHost(environment) === DEFAULT_HOSTS[environment],
  );

  if (unconfigured.length > 0) {
    const envVars = unconfigured
      .map((environment) => `AIHUB_${environment.toUpperCase()}_HOST`)
      .join(', ');

    throw new Error(
      `${envVars} must be set to a real domain outside development or test (NODE_ENV=${JSON.stringify(process.env.NODE_ENV)}). Leaving it at its placeholder default is a public, guessable value that lets a client spoof this deployment's environment via the Host header. Refusing to start rather than run with a spoofable default.`,
    );
  }
}
