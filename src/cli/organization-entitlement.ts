import { publishedEntitlements } from '@/catalog/operation-catalog';
import {
  apiKeyCacheKey,
  apiKeyCacheMissKey,
} from '@/modules/identity/application/api-key-authenticator.port';
import type {
  GrantOrganizationEntitlementResult,
  OrganizationEntitlementPort,
} from '@/modules/identity/application/organization-entitlement.port';
import { createPostgresIdentityClient } from '@/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationEntitlementRepository } from '@/modules/identity/infrastructure/postgres-organization-entitlement.repository';
import Redis from 'ioredis';
import { runOperatorCommand } from './operator-command-context';

export interface GrantOrganizationEntitlementCliInput {
  readonly databaseUrl: string;
  readonly redisUrl?: string;
  readonly organizationId: string;
  readonly actorUsername: string;
  readonly entitlement: string;
  readonly repository?: OrganizationEntitlementPort;
  readonly purge?: (hashes: readonly string[]) => Promise<void>;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

export type GrantOrganizationEntitlementCliOutcome =
  | GrantOrganizationEntitlementResult['kind']
  | 'entitlement_invalid';

async function purgeApiKeyCache(
  redisUrl: string,
  hashes: readonly string[],
): Promise<void> {
  if (hashes.length === 0) return;
  const redis = new Redis(redisUrl, {
    commandTimeout: 5_000,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    await redis.del(
      ...hashes.flatMap((hash) => [
        apiKeyCacheKey(hash),
        apiKeyCacheMissKey(hash),
      ]),
    );
  } finally {
    redis.disconnect();
  }
}

export async function runGrantOrganizationEntitlementCommand(
  input: GrantOrganizationEntitlementCliInput,
): Promise<GrantOrganizationEntitlementCliOutcome> {
  const emit = input.emit ?? console.log;
  if (!publishedEntitlements().includes(input.entitlement)) {
    emit(
      `Unknown entitlement ${input.entitlement}; supported: ${publishedEntitlements().join(', ')}.`,
    );
    return 'entitlement_invalid';
  }
  const repository =
    input.repository ??
    new PostgresOrganizationEntitlementRepository(
      createPostgresIdentityClient(input.databaseUrl),
    );
  const { result, context } = await runOperatorCommand(
    repository,
    input.now,
    ({ requestId, occurredAt }) =>
      repository.grantEntitlement({
        organizationId: input.organizationId,
        actorUsername: input.actorUsername,
        entitlement: input.entitlement,
        requestId,
        occurredAt,
      }),
  );
  if (result.kind === 'organization_not_found') {
    emit(`Organization ${input.organizationId} was not found.`);
    return result.kind;
  }
  if (result.kind === 'actor_invalid') {
    emit(`${input.actorUsername} is not an active AIHUB User Account.`);
    return result.kind;
  }
  emit(
    result.kind === 'granted'
      ? `Granted ${input.entitlement} to ${input.organizationId}; recorded as ${context.requestId}.`
      : `${input.organizationId} already has ${input.entitlement}; nothing was recorded.`,
  );
  const redisUrl = input.redisUrl?.trim() ?? '';
  if (!redisUrl) {
    emit(
      'REDIS_URL is unset, so API key identity cache was not purged; changes may take up to 60 seconds to take effect.',
    );
    return result.kind;
  }
  try {
    await (input.purge ?? ((hashes) => purgeApiKeyCache(redisUrl, hashes)))(
      result.keyHashes,
    );
    emit(`Purged the identity cache of ${result.keyHashes.length} API keys.`);
  } catch {
    emit(
      'The API key identity cache was not purged; changes may take up to 60 seconds to take effect.',
    );
  }
  return result.kind;
}
