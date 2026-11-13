import { execFileSync } from 'node:child_process';
import {
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import type { Pool } from 'pg';

import type { RedisEndpoints } from './redis-endpoint-compatibility';

export const ROOT = process.cwd();
export const COMPAT_DIR = resolve(ROOT, 'temp/n-minus-one');
export const DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/aihub';
export const CANDIDATE_PORT = 3000;
export const PREVIOUS_PORT = 3001;
export const API_HOST = 'api.ci-boot.invalid';
export const USER_ID = 'usr_01J00000000000000000000000';
export const USERNAME = 'release-compat-owner';
const require = createRequire(import.meta.url);
const bootConfigModule: unknown = require('../boot/ci-boot-config.cjs');

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

check(isRecord(bootConfigModule), 'CI boot configuration helper is invalid');
const bootConfigWriter = bootConfigModule['writeBootConfig'];
check(
  typeof bootConfigWriter === 'function',
  'CI boot configuration helper is invalid',
);
const writeBootConfig = bootConfigWriter as (directory: string) => void;
export const gradeRequest = JSON.parse(
  readFileSync(
    resolve(ROOT, 'test/fixtures/ai-writing/grade-task1.request.json'),
    'utf8',
  ),
) as { question: string; topic: string; essay: string; url: string };

export interface HttpResult {
  readonly status: number;
  readonly body: Record<string, unknown> | undefined;
}

export interface StubState {
  readonly writingCalls: number;
  readonly emailCalls: readonly string[];
  readonly verificationToken?: string;
}

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertNMinusOneGatePasses(failures: readonly string[]): void {
  if (failures.length > 0) {
    throw new Error(
      `N-1 release compatibility failed (${failures.length} finding(s))`,
    );
  }
}

export function docker(args: readonly string[], capture = false): string {
  const result = execFileSync('docker', [...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  return capture ? result.trim() : '';
}

export function imageConfig(
  directory: string,
  port: number,
  apiKey: string,
  sharedFrom: string | undefined,
): RedisEndpoints & { readonly identity_cache_hmac_key?: string } {
  mkdirSync(directory, { recursive: true });
  if (sharedFrom === undefined) {
    writeBootConfig(directory);
  } else {
    for (const file of [
      'runtime-secrets.json',
      'connection-secrets.json',
      'email-wal-secrets.json',
      'auth-mfa-secrets.json',
      'boot.env',
    ]) {
      copyFileSync(resolve(sharedFrom, file), resolve(directory, file));
    }
  }

  const runtimePath = resolve(directory, 'runtime-secrets.json');
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8')) as Record<
    string,
    Record<string, string>
  >;
  runtime['resend'] = { api_key: apiKey };
  writeFileSync(runtimePath, JSON.stringify(runtime));

  const connectionPath = resolve(directory, 'connection-secrets.json');
  const connection = JSON.parse(readFileSync(connectionPath, 'utf8')) as {
    database: Record<string, string>;
    redis: {
      url: string;
      sandbox_url: string;
      email_send_rate_url: string;
      identity_cache_hmac_key?: string;
      sandbox_identity_cache_hmac_key?: string;
    };
  };
  // This gate rehearses the reader-first rollout while the Vault key is absent.
  delete connection.redis.identity_cache_hmac_key;
  delete connection.redis.sandbox_identity_cache_hmac_key;
  const redisEndpoints: RedisEndpoints & {
    readonly identity_cache_hmac_key?: string;
  } = { ...connection.redis };
  for (const field of Object.keys(connection.database)) {
    connection.database[field] = DATABASE_URL;
  }
  connection.redis.url = 'redis://127.0.0.1:6379/0';
  connection.redis.sandbox_url = 'redis://127.0.0.1:6379/0';
  connection.redis.email_send_rate_url = 'redis://127.0.0.1:6379/2';
  writeFileSync(connectionPath, JSON.stringify(connection));
  writeFileSync(
    resolve(directory, 'email-wal-secrets.json'),
    JSON.stringify({
      email_wal_url: DATABASE_URL,
      sandbox_email_wal_url: DATABASE_URL,
    }),
  );

  copyFileSync(
    resolve(COMPAT_DIR, 'resend.crt'),
    resolve(directory, 'resend-ca.crt'),
  );
  writeFileSync(
    resolve(directory, 'resend-fetch-stub.cjs'),
    `const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => originalFetch(
  input === 'https://api.resend.com/emails' ? 'https://api.resend.com:18443/emails' : input,
  init,
);
`,
  );
  const env = Object.fromEntries(
    readFileSync(resolve(directory, 'boot.env'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  Object.assign(env, {
    PORT: String(port),
    NODE_EXTRA_CA_CERTS: '/run/secrets/aihub/resend-ca.crt',
    NODE_OPTIONS: '--require=/run/secrets/aihub/resend-fetch-stub.cjs',
    AIHUB_SELF_SERVE_MONTHLY_REQUEST_QUOTA: '100',
    AIHUB_EMAIL_VERIFICATION_REQUIRES_PASSWORD:
      process.env['AIHUB_EMAIL_VERIFICATION_REQUIRES_PASSWORD'] ?? 'false',
    DOWNSTREAM_AI_WRITING_URL: 'http://127.0.0.1:18080',
  });
  writeFileSync(
    resolve(directory, 'boot.env'),
    Object.entries(env)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')
      .concat('\n'),
  );
  return redisEndpoints;
}

export function runMigration(image: string, directory: string): void {
  docker([
    'run',
    '--rm',
    '--network',
    'host',
    '--env-file',
    resolve(directory, 'boot.env'),
    '--volume',
    `${directory}:/run/secrets/aihub:ro`,
    '--entrypoint',
    'node',
    image,
    'scripts/runtime/runtime-entrypoint.mjs',
    'scripts/cli/migrate.mjs',
  ]);
}

export function startImage(
  image: string,
  name: string,
  directory: string,
): void {
  docker(
    [
      'run',
      '--detach',
      '--init',
      '--network',
      'host',
      '--no-healthcheck',
      '--log-driver',
      'json-file',
      '--log-opt',
      'max-size=5m',
      '--log-opt',
      'max-file=1',
      '--name',
      name,
      '--add-host',
      'api.resend.com:127.0.0.1',
      '--env-file',
      resolve(directory, 'boot.env'),
      '--volume',
      `${directory}:/run/secrets/aihub:ro`,
      image,
    ],
    true,
  );
}

export function stopImage(name: string): void {
  try {
    docker(['stop', '--time', '3', name], true);
  } catch {
    // A failed startup can leave no named container to stop.
  }
  try {
    docker(['rm', '--force', name], true);
  } catch {
    // A failed startup can leave no named container to remove.
  }
}

export async function waitFor<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  message: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  // At least one read attempt runs even when the deadline is already due:
  // the deadline limits waiting between attempts, not the first attempt,
  // so a caller that probes with a very short timeout still gets its
  // `lastProbe` evidence.
  do {
    try {
      last = await read();
      if (ready(last)) return last;
    } catch {
      // The service has not bound its port yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  } while (Date.now() < deadline);
  throw new Error(message);
}

export async function request(
  port: number,
  method: string,
  path: string,
  options: {
    readonly token?: string;
    readonly apiKey?: string;
    readonly assertion?: string;
    readonly idempotencyKey?: string;
    readonly body?: unknown;
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { host: API_HOST };
  if (options.token) headers['authorization'] = `Bearer ${options.token}`;
  if (options.apiKey) headers['x-api-key'] = options.apiKey;
  if (options.assertion) headers['x-user-identity'] = options.assertion;
  if (options.idempotencyKey)
    headers['idempotency-key'] = options.idempotencyKey;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await new Promise<{ status: number; text: string }>(
    (resolveResponse, reject) => {
      const outgoing = httpRequest(
        { hostname: '127.0.0.1', port, path, method, headers },
        (incoming) => {
          let text = '';
          incoming.setEncoding('utf8');
          incoming.on('data', (chunk: string) => {
            text += chunk;
          });
          incoming.on('error', reject);
          incoming.on('end', () =>
            resolveResponse({ status: incoming.statusCode ?? 0, text }),
          );
        },
      );
      outgoing.on('error', reject);
      outgoing.end(
        options.body === undefined ? undefined : JSON.stringify(options.body),
      );
    },
  );
  const { text } = response;
  let body: Record<string, unknown> | undefined;
  if (text.length > 0) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // Report status only; response bodies can contain user or provider data.
    }
  }
  return { status: response.status, body };
}

export function expectStatus(
  result: HttpResult,
  expected: number,
  label: string,
): void {
  check(
    result.status === expected,
    `${label}: expected HTTP ${expected}, got ${result.status}`,
  );
}

export function expect2xx(result: HttpResult, label: string): void {
  check(
    result.status >= 200 && result.status < 300,
    `${label}: HTTP ${result.status}`,
  );
}

export function organizationIdOf(result: HttpResult): string {
  const data = result.body?.['data'] as Record<string, unknown> | undefined;
  const organization = data?.['organization'] as
    | Record<string, unknown>
    | undefined;
  const value = organization?.['organization_id'];
  check(typeof value === 'string', 'organization creation returned no id');
  return value;
}

export function jwt(privatePem: string, audience = 'aihub-user-api'): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: 'ci-boot-fake', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://api.ci-boot.invalid',
      aud: audience,
      sub: USER_ID,
      jti: randomUUID(),
      iat: now,
      exp: now + 900,
    }),
  ).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(unsigned),
    createPrivateKey(privatePem),
  );
  return `${unsigned}.${signature.toString('base64url')}`;
}

export function identityKeys(): {
  readonly jwks: { readonly keys: readonly Record<string, unknown>[] };
  readonly signAssertion: (issuer: string, kid: string) => string;
  readonly rotate: () => ReturnType<typeof identityKeys>;
} {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = randomUUID();
  return {
    jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] },
    signAssertion(issuer, keyId) {
      const now = Math.floor(Date.now() / 1_000);
      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', kid: keyId }),
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          iss: issuer,
          aud: 'aihub',
          sub: 'compat-student',
          iat: now,
          exp: now + 240,
          jti: randomUUID(),
        }),
      ).toString('base64url');
      const unsigned = `${header}.${payload}`;
      return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
    },
    rotate: () => identityKeys(),
  };
}

export function identityKid(identity: ReturnType<typeof identityKeys>): string {
  const kid = identity.jwks.keys[0]?.['kid'];
  check(typeof kid === 'string', 'generated identity key has no kid');
  return kid;
}

export async function stubState(): Promise<StubState> {
  const response = await fetch('http://127.0.0.1:18080/__compat/state');
  if (!response.ok) throw new Error('compatibility stubs are unavailable');
  return (await response.json()) as StubState;
}

export function safeContainerError(logs: string): string {
  const line = logs
    .split(/\r?\n/u)
    .find((entry) => /\b(error|fatal|exception)\b/iu.test(entry));
  return (
    line
      ?.replace(/(?:postgres|postgresql):\/\/[^\s"']+/giu, '[database URL]')
      .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
      .replace(
        /\b(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}]+)/giu,
        '$1=[redacted]',
      )
      .replace(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
        '[JWT]',
      ) ?? 'no error line in the last 40 log lines'
  );
}

export async function resetNMinusOneDatabase(database: Pool): Promise<void> {
  const slots = await database.query<{ active: boolean }>(
    'SELECT active FROM pg_replication_slots WHERE slot_name = $1',
    ['aihub_email_delivery'],
  );
  if (slots.rows[0]?.active) {
    throw new Error('N-1 reset cannot drop an active email replication slot');
  }
  if (slots.rows.length > 0) {
    await database.query('SELECT pg_drop_replication_slot($1)', [
      'aihub_email_delivery',
    ]);
  }
  await database.query('DROP PUBLICATION IF EXISTS aihub_email_delivery');
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
}

export async function waitReady(
  port: number,
  label: string,
  timeoutMs = 90_000,
): Promise<void> {
  let lastProbe = 'no response';
  try {
    await waitFor(
      async () => {
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        const readiness = await fetch(`http://127.0.0.1:${port}/ready`);
        lastProbe = JSON.stringify({
          healthStatus: health.status,
          readinessStatus: readiness.status,
          readiness: await readiness.json().catch(() => undefined),
        });
        return [health.status, readiness.status] as const;
      },
      ([health, readiness]) => health === 200 && readiness === 200,
      `${label} did not become ready`,
      timeoutMs,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const containerName =
      port === CANDIDATE_PORT
        ? 'aihub-compat-candidate'
        : port === PREVIOUS_PORT
          ? 'aihub-compat-previous'
          : undefined;
    let containerDetails = 'container details unavailable';
    if (containerName !== undefined) {
      try {
        const state = docker(
          ['inspect', '--format', '{{json .State}}', containerName],
          true,
        );
        containerDetails = `container state: ${state}; startup error: ${safeContainerError(docker(['logs', '--tail', '40', containerName], true))}`;
      } catch {
        // The image can exit before Docker keeps a container to inspect.
      }
    }
    throw new Error(
      `${message}; last probe: ${lastProbe}; ${containerDetails}`,
    );
  }
}
