import type { Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import { CONTROL_PLANE_READ_PRISMA_CLIENT } from '@/modules/persistence/persistence.module';

import {
  API_KEY_REPOSITORY,
  type ApiKeyRepositoryPort,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import {
  ORGANIZATION_AUDIT_EVENT_READ,
  type OrganizationAuditEventReadPort,
} from '@/modules/identity/audit/application/organization-audit-event-read.port';
import { IdentityModule } from '@/modules/identity/identity.module';
import {
  ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
  type OrganizationIdentityConfigRepositoryPort,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';

function isProvider(value: unknown): value is Provider {
  if (typeof value === 'function') {
    return true;
  }
  if (value === null || typeof value !== 'object' || !('provide' in value)) {
    return false;
  }
  return (
    'useValue' in value ||
    'useClass' in value ||
    'useFactory' in value ||
    'useExisting' in value
  );
}

const providerMetadata: unknown = Reflect.getMetadata(
  'providers',
  IdentityModule,
);
if (!Array.isArray(providerMetadata)) {
  throw new Error('Identity providers metadata is not an array');
}
const providers: Provider[] = providerMetadata.filter(isProvider);

function providerForDescription(description: string): Provider {
  const provider = providers.find(
    (candidate) =>
      'provide' in candidate &&
      typeof candidate.provide === 'symbol' &&
      candidate.provide.description === description,
  );
  if (provider === undefined) {
    throw new Error(`Identity provider not found: ${description}`);
  }
  return provider;
}

function providerForToken(token: unknown): Provider {
  const provider = providers.find(
    (candidate) => 'provide' in candidate && candidate.provide === token,
  );
  if (provider === undefined) {
    throw new Error('Identity provider not found for token');
  }
  return provider;
}

function symbolToken(provider: Provider): symbol {
  if (!('provide' in provider) || typeof provider.provide !== 'symbol') {
    throw new Error('Identity provider token is not a symbol');
  }
  return provider.provide;
}

function createClient(
  apiKeyRow: Record<string, unknown>,
  identityConfigRow: Record<string, unknown>,
) {
  const findConfig = jest.fn().mockResolvedValue(identityConfigRow);
  const query = jest.fn(async (sql: string) =>
    sql.includes('FROM api_keys') ? [apiKeyRow] : [],
  );
  const transactionClient = {
    $queryRawUnsafe: query,
    organizationIdentityConfig: { findFirst: findConfig },
  };
  const transaction = jest.fn(
    async (callback: (client: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
  );

  return {
    client: { $queryRawUnsafe: query, $transaction: transaction },
    query,
    findConfig,
    transaction,
  };
}

describe('IdentityModule database read wiring', () => {
  it('uses the writer for durable reads and does not fall back to a replica', async () => {
    const currentApiKey = {
      organizationId: 'org_acme',
      apiKeyId: 'ak_backend',
      organizationStatus: 'active',
      status: 'active',
      scopes: ['writing.grade'],
      entitlements: ['writing'],
      allowedEnvironments: ['production'],
      expiresAt: null,
      rateLimitRpm: 600,
      maxConcurrent: 20,
      monthlyRequestQuota: null,
      hardStopOnQuota: false,
    };
    const currentIdentityConfig = {
      organizationId: 'org_acme',
      issuer: 'https://acme.edu',
      jwksUrl: 'https://acme.edu/.well-known/jwks.json',
      publicKeysJwks: null,
      allowedAlgorithms: ['RS256'],
      maxAssertionTtlSeconds: 300,
      status: 'active',
      jwksCacheVersion: 2n,
    };
    const staleApiKey = { ...currentApiKey, status: 'revoked' };
    const staleIdentityConfig = {
      ...currentIdentityConfig,
      issuer: 'https://stale.acme.edu',
      jwksCacheVersion: 1n,
    };
    const writer = createClient(currentApiKey, currentIdentityConfig);
    const replica = createClient(staleApiKey, staleIdentityConfig);
    const transactionToken = symbolToken(
      providerForDescription('IDENTITY_TRANSACTION_CLIENT'),
    );

    const module = await Test.createTestingModule({
      providers: [
        { provide: transactionToken, useValue: writer.client },
        {
          provide: CONTROL_PLANE_READ_PRISMA_CLIENT,
          useValue: { prisma: replica.client },
        },
        providerForDescription('IDENTITY_READ_CLIENT'),
        providerForToken(API_KEY_REPOSITORY),
        providerForToken(ORGANIZATION_IDENTITY_CONFIG_REPOSITORY),
        providerForToken(ORGANIZATION_AUDIT_EVENT_READ),
      ],
    }).compile();

    const apiKeys = module.get<ApiKeyRepositoryPort>(API_KEY_REPOSITORY);
    await expect(apiKeys.findByHash('a'.repeat(64))).resolves.toMatchObject({
      status: 'active',
    });
    expect(writer.query).toHaveBeenCalledTimes(1);
    expect(replica.query).not.toHaveBeenCalled();

    const configs = module.get<OrganizationIdentityConfigRepositoryPort>(
      ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
    );
    await expect(
      configs.findActiveByOrganizationId('org_acme'),
    ).resolves.toMatchObject({
      issuer: 'https://acme.edu',
      jwksCacheVersion: '2',
    });
    expect(writer.findConfig).toHaveBeenCalledTimes(1);
    expect(replica.findConfig).not.toHaveBeenCalled();

    const audit = module.get<OrganizationAuditEventReadPort>(
      ORGANIZATION_AUDIT_EVENT_READ,
    );
    await expect(
      audit.listAuditEvents({
        context: createRequestContext({
          requestId: 'req_01J00000000000000000000000',
          receivedAt: new Date('2026-09-22T00:00:00.000Z'),
          deadlineMs: 5_000,
          organizationId: 'org_acme',
          userId: 'usr_01J00000000000000000000000',
          scopes: [],
        }),
        organizationId: 'org_acme',
        filter: {},
        limit: 10,
      }),
    ).resolves.toEqual([]);
    expect(writer.transaction).toHaveBeenCalledTimes(2);
    expect(replica.transaction).not.toHaveBeenCalled();

    writer.query.mockRejectedValueOnce(
      Object.assign(new Error('writer unreachable'), { code: 'P1001' }),
    );
    await expect(apiKeys.findByHash('b'.repeat(64))).rejects.toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
    expect(replica.query).not.toHaveBeenCalled();

    await module.close();
  });
});
