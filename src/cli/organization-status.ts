import Redis from 'ioredis';
import { ulid } from 'ulid';

import type { OrganizationStatus } from '../modules/identity/application/api-key-authenticator.port';
import type {
  OrganizationStatusPort,
  SetOrganizationStatusResult,
} from '../modules/identity/application/organization-status.port';
import { createPostgresIdentityClient } from '../modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationStatusRepository } from '../modules/identity/infrastructure/postgres-organization-status.repository';
import { apiKeyCacheKeys } from '../modules/identity/infrastructure/redis-identity.store';

export interface OrganizationStatusCliInput {
  readonly databaseUrl: string;
  readonly redisUrl: string | undefined;
  readonly organizationId: string;
  readonly actorUsername: string;
  readonly status: OrganizationStatus;
  readonly repository?: OrganizationStatusPort;
  readonly purge?: (keyHashes: readonly string[]) => Promise<void>;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

export type OrganizationStatusCliOutcome = SetOrganizationStatusResult['kind'];

const CACHE_CEILING =
  'its API keys may keep their previous status for up to 60 seconds';

/**
 * One-shot connection settings, as `key:revoke` uses: lazy connect with an
 * explicit `connect()` so the delete is not issued before the socket is ready,
 * and timeouts loose enough for a workstation reaching Redis through a tunnel.
 */
async function purgeApiKeyCache(
  redisUrl: string,
  keyHashes: readonly string[],
): Promise<void> {
  if (keyHashes.length === 0) {
    return;
  }
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
    await redis.del(...keyHashes.flatMap((hash) => apiKeyCacheKeys(hash)));
  } finally {
    redis.disconnect();
  }
}

/**
 * Suspends or restores an Organization as an operator (ADR-0044). The status
 * and its audit event commit first; the cache purge follows and its failure is
 * reported, never allowed to read as the act itself failing.
 */
export async function runOrganizationStatusCommand(
  input: OrganizationStatusCliInput,
): Promise<OrganizationStatusCliOutcome> {
  const emit = input.emit ?? console.log;
  const now = input.now ?? (() => new Date());
  const requestId = `req_${ulid()}`;
  const repository =
    input.repository ??
    new PostgresOrganizationStatusRepository(
      createPostgresIdentityClient(input.databaseUrl),
    );

  let result: SetOrganizationStatusResult;
  try {
    result = await repository.setOrganizationStatus({
      organizationId: input.organizationId,
      actorUsername: input.actorUsername,
      status: input.status,
      requestId,
      occurredAt: now(),
    });
  } finally {
    await repository.close();
  }

  // Named separately so an operator can tell a mistyped `--org` from a
  // mistyped `--actor`; the process still exits as a usage error.
  if (result.kind === 'organization_not_found') {
    emit(`Organization ${input.organizationId} was not found.`);
    return result.kind;
  }
  if (result.kind === 'actor_invalid') {
    emit(`${input.actorUsername} is not an active AIHUB User Account.`);
    return result.kind;
  }

  const verb = input.status === 'suspended' ? 'Suspended' : 'Restored';
  emit(
    result.kind === 'changed'
      ? `${verb} ${input.organizationId}; recorded as ${requestId}.`
      : `${input.organizationId} is already ${input.status}; nothing was recorded.`,
  );

  // Purged on a repeat too: rerunning is how an operator closes a window a
  // failed purge left open.
  const redisUrl = input.redisUrl?.trim() ?? '';
  if (redisUrl.length === 0) {
    emit(
      `REDIS_URL is unset, so the identity cache was not purged; ${CACHE_CEILING}.`,
    );
    return result.kind;
  }
  const purge = input.purge ?? ((hashes) => purgeApiKeyCache(redisUrl, hashes));
  try {
    await purge(result.keyHashes);
    emit(`Purged the identity cache of ${result.keyHashes.length} API keys.`);
  } catch {
    emit(`The identity cache was not purged; ${CACHE_CEILING}.`);
  }

  return result.kind;
}
