import Fastify, { type FastifyInstance } from 'fastify';

import { createAppFastifyProxyOptions } from '@/app-fastify-proxy-options';
import { AppError } from '@/common/errors/app-error';
import {
  AUTH_FAILURE_LIMIT,
  ApiKeyAuthenticator,
} from '@/modules/identity/api-keys/application/api-key-authenticator';
import type {
  ApiKeyCachePort,
  ApiKeyRepositoryPort,
  AuthFailureCounterPort,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import type { RequestEnvironmentConfig } from '@/modules/identity/shared/presentation/request-environment';
import { authenticateApiKey } from './authenticate-api-key';

const REQUEST_CONFIG: RequestEnvironmentConfig = {
  NODE_ENV: 'test',
  AIHUB_ALLOW_UNAUTHENTICATED_DEV: false,
  AIHUB_RUNTIME_DATABASE_SCOPE: 'production',
  AIHUB_PRODUCTION_HOST: undefined,
  AIHUB_STAGING_HOST: undefined,
  AIHUB_DEVELOPMENT_HOST: undefined,
  AIHUB_SANDBOX_HOST: undefined,
};

class IpFailureCounter implements AuthFailureCounterPort {
  private readonly failures = new Map<string, number>();
  lookupBudgetAllowed = true;
  lookupBudgetCalls = 0;

  clear(): void {
    this.failures.clear();
  }

  async get(ip: string): Promise<number> {
    return this.failures.get(ip) ?? 0;
  }

  async recordFailure(ip: string): Promise<number> {
    const failures = (this.failures.get(ip) ?? 0) + 1;
    this.failures.set(ip, failures);
    return failures;
  }

  async consumeSandboxKeyLookup(): Promise<boolean> {
    return true;
  }

  async consumeUncachedLookup() {
    this.lookupBudgetCalls += 1;
    return this.lookupBudgetAllowed
      ? { allowed: true as const }
      : {
          allowed: false as const,
          retryAfterMs: 45_000,
        };
  }
}

describe('API-key failure budgets behind the trusted proxy', () => {
  let fastify: FastifyInstance;
  let failures: IpFailureCounter;
  let authenticator: ApiKeyAuthenticator;
  let repositoryLookups: number;

  beforeAll(async () => {
    failures = new IpFailureCounter();
    repositoryLookups = 0;
    authenticator = new ApiKeyAuthenticator(
      {
        findByHash: async () => {
          repositoryLookups += 1;
          return null;
        },
        touchLastUsed: async () => undefined,
      } satisfies ApiKeyRepositoryPort,
      {
        get: async () => undefined,
        set: async () => undefined,
        setMiss: async () => undefined,
        delete: async () => undefined,
      } satisfies ApiKeyCachePort,
      failures,
    );

    fastify = Fastify(createAppFastifyProxyOptions('172.16.7.1'));
    fastify.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        if (error.retryAfterMs !== undefined) {
          reply.header(
            'Retry-After',
            String(Math.ceil(error.retryAfterMs / 1_000)),
          );
        }
        return reply.status(error.httpStatus).send({ code: error.code });
      }
      return reply.status(500).send({ code: 'INTERNAL_ERROR' });
    });
    fastify.post('/api-key', async (request) => {
      await authenticateApiKey(
        request as AuthenticatedRequest,
        authenticator,
        REQUEST_CONFIG,
      );
      return { authenticated: true };
    });
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
  });

  beforeEach(() => {
    failures.clear();
    failures.lookupBudgetAllowed = true;
    failures.lookupBudgetCalls = 0;
    repositoryLookups = 0;
  });

  async function attempt(
    clientIp: string,
    forgedIp: string,
    remoteAddress = '172.16.7.1',
    apiKey = 'invalid',
  ) {
    return fastify.inject({
      method: 'POST',
      url: '/api-key',
      remoteAddress,
      headers: {
        host: 'localhost',
        'x-api-key': apiKey,
        'x-forwarded-for': `${forgedIp}, ${clientIp}`,
      },
    });
  }

  it('uses nginx’s rightmost forwarded address and separates failure budgets', async () => {
    for (let count = 1; count <= AUTH_FAILURE_LIMIT; count += 1) {
      const response = await attempt('198.51.100.10', '198.51.100.11');
      expect(response.statusCode).toBe(
        count === AUTH_FAILURE_LIMIT ? 429 : 401,
      );
    }

    const otherCaller = await attempt('198.51.100.11', '198.51.100.10');
    const blockedCaller = await attempt('198.51.100.10', '198.51.100.11');
    const directPeer = await attempt(
      '198.51.100.11',
      '198.51.100.10',
      '172.16.3.4',
    );

    expect(otherCaller.statusCode).toBe(401);
    expect(blockedCaller.statusCode).toBe(429);
    expect(directPeer.statusCode).toBe(401);
    await expect(failures.get('198.51.100.10')).resolves.toBe(
      AUTH_FAILURE_LIMIT + 1,
    );
    await expect(failures.get('198.51.100.11')).resolves.toBe(1);
    await expect(failures.get('172.16.3.4')).resolves.toBe(1);
  });

  it('counts a request whose peer has no address under one shared key instead of failing', async () => {
    // A Unix-socket peer carries no address, and a request without a forwarded
    // header then leaves `request.ip` undefined.
    const request = {
      ip: undefined,
      headers: { host: 'localhost', 'x-api-key': 'invalid' },
    } as unknown as AuthenticatedRequest;

    await expect(
      authenticateApiKey(request, authenticator, REQUEST_CONFIG),
    ).rejects.toMatchObject({ httpStatus: 401 });
    await expect(failures.get('unknown')).resolves.toBe(1);
  });

  it('refuses an uncached lookup over HTTP with Retry-After before Postgres', async () => {
    failures.lookupBudgetAllowed = false;

    const response = await attempt(
      '198.51.100.10',
      '198.51.100.11',
      '172.16.7.1',
      `aihub_sk_${'A'.repeat(43)}`,
    );

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('45');
    expect(response.json()).toEqual({ code: 'RATE_LIMITED' });
    expect(failures.lookupBudgetCalls).toBe(1);
    expect(repositoryLookups).toBe(0);
  });
});
