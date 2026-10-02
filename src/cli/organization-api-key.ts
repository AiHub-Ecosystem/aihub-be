import type {
  CreateOperatorApiKeyResult,
  OperatorApiKeyPort,
  RevokeOperatorApiKeyResult,
} from '@/modules/identity/application/operator-api-key.port';
import { createPostgresIdentityClient } from '@/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOperatorApiKeyRepository } from '@/modules/identity/infrastructure/postgres-operator-api-key.repository';
import { runOperatorCommand } from './operator-command-context';
import { purgeApiKeyCache } from './organization-status';

/**
 * A credential `scripts/cli.mjs` already generated. The raw value is carried
 * only to be printed after commit; it never reaches the repository.
 */
export interface GeneratedApiKeyCredential {
  readonly id: string;
  readonly hash: string;
  readonly prefix: string;
  readonly raw: string;
}

export interface CreateOperatorApiKeyCliInput {
  readonly databaseUrl: string;
  readonly organizationId: string;
  readonly actorUsername: string;
  readonly credential: GeneratedApiKeyCredential;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly allowedEnvironments: readonly string[];
  readonly repository?: OperatorApiKeyPort;
  /** The raw key, on stdout: `demo-bootstrap` captures it from there. */
  readonly print?: (line: string) => void;
  /** Everything else, on stderr, so stdout stays exactly the raw key. */
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

export interface RevokeOperatorApiKeyCliInput {
  readonly databaseUrl: string;
  readonly redisUrl: string | undefined;
  readonly apiKeyId: string;
  readonly actorUsername: string;
  readonly repository?: OperatorApiKeyPort;
  readonly purge?: (keyHashes: readonly string[]) => Promise<void>;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

export type CreateOperatorApiKeyCliOutcome = CreateOperatorApiKeyResult['kind'];
export type RevokeOperatorApiKeyCliOutcome = RevokeOperatorApiKeyResult['kind'];

const CACHE_CEILING = 'the key may still be accepted for up to 60 seconds';

function openRepository(
  databaseUrl: string,
  repository: OperatorApiKeyPort | undefined,
): OperatorApiKeyPort {
  return (
    repository ??
    new PostgresOperatorApiKeyRepository(
      createPostgresIdentityClient(databaseUrl),
    )
  );
}

/**
 * Issues an Organization API key as an operator. The key row and its
 * `api_key.created` event commit together; the raw key is printed only once
 * that has happened, and never persisted.
 */
export async function runCreateOperatorApiKeyCommand(
  input: CreateOperatorApiKeyCliInput,
): Promise<CreateOperatorApiKeyCliOutcome> {
  const print = input.print ?? console.log;
  const emit = input.emit ?? console.error;
  const repository = openRepository(input.databaseUrl, input.repository);
  const { result } = await runOperatorCommand(
    repository,
    input.now,
    ({ requestId, occurredAt }) =>
      repository.createApiKey({
        organizationId: input.organizationId,
        actorUsername: input.actorUsername,
        apiKeyId: input.credential.id,
        keyHash: input.credential.hash,
        keyPrefix: input.credential.prefix,
        name: input.name,
        scopes: input.scopes,
        allowedEnvironments: input.allowedEnvironments,
        requestId,
        occurredAt,
      }),
  );

  if (result.kind === 'actor_invalid') {
    emit(`${input.actorUsername} is not an active AIHUB User Account.`);
  } else if (result.kind === 'organization_unavailable') {
    emit(
      `Organization ${input.organizationId} was not found or is not active.`,
    );
  } else {
    print(input.credential.raw);
  }
  return result.kind;
}

/**
 * Revokes one API key as an operator. The revocation and its
 * `api_key.revoked` event commit first; the cache purge follows and its failure
 * is reported, never allowed to read as the revocation failing.
 */
export async function runRevokeOperatorApiKeyCommand(
  input: RevokeOperatorApiKeyCliInput,
): Promise<RevokeOperatorApiKeyCliOutcome> {
  const emit = input.emit ?? console.error;
  const repository = openRepository(input.databaseUrl, input.repository);
  const { result } = await runOperatorCommand(
    repository,
    input.now,
    ({ requestId, occurredAt }) =>
      repository.revokeApiKey({
        apiKeyId: input.apiKeyId,
        actorUsername: input.actorUsername,
        requestId,
        occurredAt,
      }),
  );

  if (result.kind === 'actor_invalid') {
    emit(`${input.actorUsername} is not an active AIHUB User Account.`);
    return result.kind;
  }
  if (result.kind === 'key_not_found') {
    emit(`API key ${input.apiKeyId} was not found.`);
    return result.kind;
  }

  // Purged on a repeat too: rerunning is how an operator closes a window a
  // failed purge left open.
  const redisUrl = input.redisUrl?.trim() ?? '';
  if (redisUrl.length === 0) {
    emit(
      `Revoked ${input.apiKeyId}. REDIS_URL is unset, so the identity cache was not purged; ${CACHE_CEILING}.`,
    );
    return result.kind;
  }
  const purge = input.purge ?? ((hashes) => purgeApiKeyCache(redisUrl, hashes));
  try {
    await purge([result.keyHash]);
    emit(`Revoked ${input.apiKeyId} and purged its identity cache entry.`);
  } catch {
    emit(
      `Revoked ${input.apiKeyId}, but could not purge the identity cache; ${CACHE_CEILING}.`,
    );
  }
  return result.kind;
}
