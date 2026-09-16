import type { FastifyRequest } from 'fastify';

import { AppError } from '../../../common/errors/app-error';

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

const PLACEHOLDER_HOSTS: Readonly<Record<AihubEnvironment, string>> = {
  production: 'api.aihub.example.com',
  staging: 'staging-api.aihub.example.com',
  development: 'dev-api.aihub.example.com',
  sandbox: 'sandbox-api.aihub.example.com',
};

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function hostVariable(environment: AihubEnvironment): string {
  return `AIHUB_${environment.toUpperCase()}_HOST`;
}

function normalizeConfiguredHost(value: string, envVar: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/, '');

  if (!HOSTNAME_PATTERN.test(hostname)) {
    throw new Error(
      `${envVar} must be a hostname without a scheme, wildcard, port, path, or credentials`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(`https://${hostname}`);
  } catch {
    throw new Error(`${envVar} must be a valid hostname`);
  }

  if (
    parsed.hostname !== hostname ||
    parsed.port !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error(
      `${envVar} must be a hostname without a scheme, wildcard, port, path, or credentials`,
    );
  }

  return hostname;
}

function configuredHost(environment: AihubEnvironment): string | undefined {
  const envVar = hostVariable(environment);
  const value = process.env[envVar];
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return normalizeConfiguredHost(value, envVar);
}

function publicHostEnvironments(): ReadonlyMap<string, AihubEnvironment> {
  const hosts = new Map<string, AihubEnvironment>();

  for (const environment of ENVIRONMENTS) {
    const hostname = configuredHost(environment);
    if (hostname === undefined) {
      continue;
    }

    const previousEnvironment = hosts.get(hostname);
    if (previousEnvironment !== undefined) {
      throw new Error(
        `${hostVariable(environment)} must not use the same hostname as ${hostVariable(previousEnvironment)}`,
      );
    }

    hosts.set(hostname, environment);
  }

  return hosts;
}

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
 * The Host header is client-supplied, so an unset or placeholder host must
 * never silently become a public environment. Production is mandatory;
 * staging, development, and sandbox are optional and are absent when unset.
 */
export function assertHostConfigurationIsSafe(): void {
  const configured = new Map<string, AihubEnvironment>();
  const missingRequired: string[] = [];
  const placeholders: string[] = [];

  for (const environment of ENVIRONMENTS) {
    const envVar = hostVariable(environment);
    const rawValue = process.env[envVar];
    if (rawValue === undefined || rawValue.trim().length === 0) {
      if (environment === 'production' && !isDevOrTestProcess()) {
        missingRequired.push(envVar);
      }
      continue;
    }

    const hostname = normalizeConfiguredHost(rawValue, envVar);
    const previousEnvironment = configured.get(hostname);
    if (previousEnvironment !== undefined) {
      throw new Error(
        `${envVar} must not use the same hostname as ${hostVariable(previousEnvironment)}`,
      );
    }
    configured.set(hostname, environment);

    if (!isDevOrTestProcess() && PLACEHOLDER_HOSTS[environment] === hostname) {
      placeholders.push(envVar);
    }
  }

  const unsafe = [...missingRequired, ...placeholders];
  if (unsafe.length > 0) {
    throw new Error(
      `${unsafe.join(', ')} must be set to real, configured hostnames outside development or test (NODE_ENV=${JSON.stringify(process.env.NODE_ENV)}). Refusing to start rather than run with a spoofable placeholder or missing production binding.`,
    );
  }
}
