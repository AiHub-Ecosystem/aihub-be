import type { RequestContext } from '@/common/request-context/request-context';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import { ScriptedPrisma } from '@/modules/persistence/testing/query-fake-client';
import { PostgresOrganizationApiKeyRepository } from './postgres-organization-api-key.repository';

function context(organizationId?: string): RequestContext {
  return createRequestContext({
    requestId: 'req_01J00000000000000000000000',
    receivedAt: new Date('2026-09-21T00:00:00.000Z'),
    deadlineMs: 5_000,
    ...(organizationId === undefined ? {} : { organizationId }),
    scopes: [],
  });
}

const now = new Date('2026-09-21T00:00:00.000Z');

const methods = [
  {
    name: 'createApiKey',
    message: 'Identity API key input is invalid',
    invoke: (
      repository: PostgresOrganizationApiKeyRepository,
      ctx: RequestContext,
    ) =>
      repository.createApiKey({
        context: ctx,
        organizationId: 'org_acme',
        actorUserId: 'usr_actor',
        apiKeyId: 'key_01J00000000000000000000000',
        keyHash: 'a'.repeat(64),
        keyPrefix: 'aik_test',
        name: 'Test key',
        scopes: ['ai-writing:grade'],
        allowedEnvironments: ['production'],
        expiresAt: null,
        requiredEntitlements: ['writing'],
        activeKeyLimit: 5,
      }),
  },
  {
    name: 'listApiKeys',
    message: 'Identity API key query is invalid',
    invoke: (
      repository: PostgresOrganizationApiKeyRepository,
      ctx: RequestContext,
    ) => repository.listApiKeys({ context: ctx, organizationId: 'org_acme' }),
  },
  {
    name: 'rotateApiKey',
    message: 'Identity API key rotation input is invalid',
    invoke: (
      repository: PostgresOrganizationApiKeyRepository,
      ctx: RequestContext,
    ) =>
      repository.rotateApiKey({
        context: ctx,
        organizationId: 'org_acme',
        actorUserId: 'usr_actor',
        apiKeyId: 'key_01J00000000000000000000000',
        replacementId: 'key_01J00000000000000000000001',
        keyHash: 'b'.repeat(64),
        keyPrefix: 'aik_next',
        retiredAllowedEnvironments: ['production'],
        replacementAllowedEnvironments: ['production'],
        now,
      }),
  },
  {
    name: 'revokeApiKey',
    message: 'Identity API key revocation input is invalid',
    invoke: (
      repository: PostgresOrganizationApiKeyRepository,
      ctx: RequestContext,
    ) =>
      repository.revokeApiKey({
        context: ctx,
        organizationId: 'org_acme',
        actorUserId: 'usr_actor',
        apiKeyId: 'key_01J00000000000000000000000',
        now,
      }),
  },
] as const;

describe('PostgresOrganizationApiKeyRepository organization context', () => {
  it.each(methods)(
    '$name requires its Organization context',
    async ({ invoke, message }) => {
      for (const organizationId of [undefined, 'org_other']) {
        const prisma = new ScriptedPrisma();
        const repository = new PostgresOrganizationApiKeyRepository(
          prisma.client(),
        );

        await expect(
          invoke(repository, context(organizationId)),
        ).rejects.toMatchObject({
          message,
        });
        expect(prisma.opened).toBe(0);
        expect(prisma.statements).toHaveLength(0);
      }
    },
  );
});
