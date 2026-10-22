import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { type Server, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { generateApiKey } from '@/modules/identity/api-keys/application/organization-api-key-generator';
import type { GeneratedApiKey } from '@/modules/identity/domain/api-key';

import { sandboxTestRedisUrl, testDatabaseUrl } from '../shared/database';
import {
  createTenantIdentity,
  signUserAssertion,
} from '../tenant-isolation/fixtures';

/**
 * A real AIHUB Nest process, started as a child of a database-lane spec so the
 * spec can kill it (`dispatch-attempt-crash.worker.spec.ts` is its body).
 */
export interface TestWorker {
  readonly child: ChildProcess;
  readonly url: string;
  stop(): Promise<void>;
}

export const WRITING_TASK1_PATH = '/v1/ielts/writing/task1/grade';

export function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('mock AI Service did not expose a port'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

export async function startWorker(configuration: {
  readonly downstreamUrl: string;
  readonly redisUrl?: string;
}): Promise<TestWorker> {
  const worker = spawn(
    process.execPath,
    [
      join(process.cwd(), 'node_modules/jest/bin/jest.js'),
      '--config',
      'jest.config.db-worker.cjs',
      '--runInBand',
      '--runTestsByPath',
      join(__dirname, 'dispatch-attempt-crash.worker.spec.ts'),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AIHUB_RUNTIME_SECRET_SOURCE: 'env',
        AIHUB_RUNTIME_DATABASE_SCOPE: 'production',
        DATABASE_URL: testDatabaseUrl(),
        CONTROL_PLANE_DATABASE_URL: testDatabaseUrl(),
        CONTROL_PLANE_READ_DATABASE_URL: testDatabaseUrl(),
        REDIS_URL: configuration.redisUrl ?? sandboxTestRedisUrl(),
        DOWNSTREAM_AI_WRITING_URL: configuration.downstreamUrl,
        DOWNSTREAM_AI_SPEAKING_URL: configuration.downstreamUrl,
        AIHUB_PRODUCTION_HOST: 'api.production.test',
        AIHUB_STAGING_HOST: 'api.staging.test',
        AIHUB_DEVELOPMENT_HOST: 'api.development.test',
        AIHUB_SANDBOX_HOST: 'api.sandbox.test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderr = '';
  worker.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ready = new Promise<number>((resolve, reject) => {
    const lines = createInterface({ input: worker.stdout! });
    const timeout = setTimeout(() => {
      lines.close();
      reject(new Error(`AIHUB test worker did not start: ${stderr}`));
    }, 45_000);
    lines.on('line', (line) => {
      const port = Number(line.match(/^AIHUB_TEST_READY:(\d+)$/)?.[1]);
      if (Number.isSafeInteger(port) && port > 0) {
        clearTimeout(timeout);
        lines.close();
        resolve(port);
      }
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`AIHUB test worker exited before ready (${code}): ${stderr}`),
      );
    });
  });
  let port: number;
  try {
    port = await ready;
  } catch (error) {
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGKILL');
      await once(worker, 'exit').catch(() => undefined);
    }
    throw error;
  }
  return {
    child: worker,
    url: `http://127.0.0.1:${port}`,
    async stop() {
      if (worker.exitCode !== null || worker.signalCode !== null) return;
      const exited = once(worker, 'exit');
      worker.kill('SIGTERM');
      await exited;
    },
  };
}

export async function killWorker(worker: TestWorker): Promise<void> {
  const exited = once(worker.child, 'exit');
  worker.child.kill('SIGKILL');
  await exited;
}

export function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface HttpAnswer {
  readonly status: number;
  readonly body: string;
}

/** One HTTP call to a worker; `undefined` when the connection broke. */
export function sendRequest(
  appUrl: string,
  request: {
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  },
): Promise<HttpAnswer | undefined> {
  const app = new URL(appUrl);
  return new Promise((resolve) => {
    const outgoing = httpRequest(
      {
        hostname: app.hostname,
        port: Number(app.port),
        path: request.path,
        method: 'POST',
        headers: {
          host: 'api.production.test',
          'content-type': 'application/json',
          ...request.headers,
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body }),
        );
      },
    );
    outgoing.on('error', () => resolve(undefined));
    outgoing.end(
      request.body === undefined ? undefined : JSON.stringify(request.body),
    );
  });
}

export interface GradingOrganization {
  readonly organizationId: string;
  readonly apiKey: GeneratedApiKey;
  readonly assertion: string;
}

/** A production Organization with a Writing key and a signed identity. */
export async function seedGradingOrganization(
  pool: Pool,
  options: {
    readonly label: string;
    readonly maxConcurrent: number;
    readonly monthlyQuota: number;
    readonly hardStop: boolean;
  },
): Promise<GradingOrganization> {
  const organizationId = `org_${options.label}_${ulid().toLowerCase()}`;
  const apiKey = generateApiKey(`ak_${options.label}_${ulid().toLowerCase()}`);
  const identity = await createTenantIdentity(
    `https://identity.${options.label}.test`,
    `${options.label}-${ulid().toLowerCase()}`,
  );
  await pool.query(
    `INSERT INTO organizations
       (id, name, entitlements, rate_limit_rpm, max_concurrent,
        monthly_request_quota, hard_stop_on_quota)
     VALUES ($1, $2, ARRAY['writing'], 600, $3, $4, $5)`,
    [
      organizationId,
      `${options.label} test`,
      options.maxConcurrent,
      options.monthlyQuota,
      options.hardStop,
    ],
  );
  await pool.query(
    `INSERT INTO api_keys
       (id, organization_id, key_hash, key_prefix, name, scopes,
        allowed_environments, status)
     VALUES ($1, $2, decode($3, 'hex'), $4, $5,
       ARRAY['writing.grade'], ARRAY['production'], 'active')`,
    [
      apiKey.id,
      organizationId,
      apiKey.hash,
      apiKey.prefix,
      `${options.label} test`,
    ],
  );
  await pool.query(
    `INSERT INTO organization_identity_configs
       (organization_id, issuer, jwks_url, public_keys_jwks,
        allowed_algorithms, max_assertion_ttl_seconds, status)
     VALUES ($1, $2, NULL, $3::jsonb, ARRAY['RS256'], 300, 'active')`,
    [organizationId, identity.issuer, JSON.stringify(identity.jwks)],
  );
  return {
    organizationId,
    apiKey,
    assertion: await signUserAssertion(identity, new Date()),
  };
}

/** Removes every row a grading Organization's test left behind. */
export async function deleteGradingOrganization(
  pool: Pool,
  organizationId: string,
): Promise<void> {
  for (const table of [
    'usage_records',
    'dispatch_attempts',
    'idempotency_records',
    'sandbox_dispatch_reservations',
    'api_keys',
    'organization_identity_configs',
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [
      organizationId,
    ]);
  }
  await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
}
