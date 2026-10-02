import type {
  CreateOperatorApiKeyInput,
  CreateOperatorApiKeyResult,
  OperatorApiKeyPort,
  RevokeOperatorApiKeyInput,
  RevokeOperatorApiKeyResult,
} from '@/modules/identity/application/operator-api-key.port';

import {
  type CreateOperatorApiKeyCliInput,
  type RevokeOperatorApiKeyCliInput,
  runCreateOperatorApiKeyCommand,
  runRevokeOperatorApiKeyCommand,
} from './organization-api-key';

class OperatorApiKeyFake implements OperatorApiKeyPort {
  readonly created: CreateOperatorApiKeyInput[] = [];
  readonly revoked: RevokeOperatorApiKeyInput[] = [];
  closed = false;

  constructor(
    private readonly createResult: CreateOperatorApiKeyResult = {
      kind: 'created',
    },
    private readonly revokeResult: RevokeOperatorApiKeyResult = {
      kind: 'revoked',
      keyHash: 'aa',
    },
  ) {}

  async createApiKey(
    input: CreateOperatorApiKeyInput,
  ): Promise<CreateOperatorApiKeyResult> {
    this.created.push(input);
    return this.createResult;
  }

  async revokeApiKey(
    input: RevokeOperatorApiKeyInput,
  ): Promise<RevokeOperatorApiKeyResult> {
    this.revoked.push(input);
    return this.revokeResult;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const NOW = new Date('2026-10-02T10:00:00.000Z');

function create(
  result?: CreateOperatorApiKeyResult,
  overrides: Partial<CreateOperatorApiKeyCliInput> = {},
) {
  const repository = new OperatorApiKeyFake(result);
  const printed: string[] = [];
  const lines: string[] = [];
  const outcome = runCreateOperatorApiKeyCommand({
    databaseUrl: 'postgres://unused',
    organizationId: 'org_acme',
    actorUsername: 'aihub-ops-alice',
    credential: {
      id: 'ak_01',
      hash: 'f'.repeat(64),
      prefix: 'aih_live_abcd',
      raw: 'aih_live_abcd_SECRET',
    },
    name: 'Prod backend',
    scopes: ['writing.grade'],
    allowedEnvironments: ['production'],
    repository,
    print: (line) => printed.push(line),
    emit: (line) => lines.push(line),
    now: () => NOW,
    ...overrides,
  });
  return { outcome, repository, printed, lines };
}

function revoke(
  result?: RevokeOperatorApiKeyResult,
  overrides: Partial<RevokeOperatorApiKeyCliInput> = {},
) {
  const repository = new OperatorApiKeyFake(undefined, result);
  const purged: string[][] = [];
  const lines: string[] = [];
  const outcome = runRevokeOperatorApiKeyCommand({
    databaseUrl: 'postgres://unused',
    redisUrl: 'redis://unused',
    apiKeyId: 'ak_01',
    actorUsername: 'aihub-ops-alice',
    repository,
    purge: async (hashes) => {
      purged.push([...hashes]);
    },
    emit: (line) => lines.push(line),
    now: () => NOW,
    ...overrides,
  });
  return { outcome, repository, purged, lines };
}

describe('runCreateOperatorApiKeyCommand', () => {
  it('records the key with the operator as actor and prints the raw key once', async () => {
    const { outcome, repository, printed, lines } = create();

    await expect(outcome).resolves.toBe('created');
    const [call] = repository.created;
    expect(call).toMatchObject({
      organizationId: 'org_acme',
      actorUsername: 'aihub-ops-alice',
      apiKeyId: 'ak_01',
      keyHash: 'f'.repeat(64),
      keyPrefix: 'aih_live_abcd',
      name: 'Prod backend',
      scopes: ['writing.grade'],
      allowedEnvironments: ['production'],
      occurredAt: NOW,
    });
    expect(call?.requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(JSON.stringify(call)).not.toContain('SECRET');
    expect(printed).toEqual(['aih_live_abcd_SECRET']);
    expect(lines).toEqual([]);
    expect(repository.closed).toBe(true);
  });

  it.each([
    ['actor_invalid', 'aihub-ops-alice is not an active AIHUB User Account.'],
    [
      'organization_unavailable',
      'Organization org_acme was not found or is not active.',
    ],
  ] as const)('names %s and never prints the key', async (kind, message) => {
    const { outcome, printed, lines, repository } = create({ kind });

    await expect(outcome).resolves.toBe(kind);
    expect(printed).toEqual([]);
    expect(lines).toEqual([message]);
    expect(repository.closed).toBe(true);
  });
});

describe('runRevokeOperatorApiKeyCommand', () => {
  it('revokes with the operator as actor and purges the key', async () => {
    const { outcome, repository, purged, lines } = revoke();

    await expect(outcome).resolves.toBe('revoked');
    const [call] = repository.revoked;
    expect(call).toMatchObject({
      apiKeyId: 'ak_01',
      actorUsername: 'aihub-ops-alice',
      occurredAt: NOW,
    });
    expect(call?.requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(purged).toEqual([['aa']]);
    expect(lines).toEqual([
      'Revoked ak_01 and purged its identity cache entry.',
    ]);
    expect(repository.closed).toBe(true);
  });

  it('answers a repeat the same way and still purges', async () => {
    const { outcome, purged, lines } = revoke({
      kind: 'unchanged',
      keyHash: 'aa',
    });

    await expect(outcome).resolves.toBe('unchanged');
    expect(purged).toEqual([['aa']]);
    expect(lines).toEqual([
      'Revoked ak_01 and purged its identity cache entry.',
    ]);
  });

  it('keeps the revocation and says what is left open when the purge fails', async () => {
    const { outcome, lines } = revoke(undefined, {
      purge: async () => {
        throw new Error('redis down');
      },
    });

    await expect(outcome).resolves.toBe('revoked');
    expect(lines).toEqual([
      'Revoked ak_01, but could not purge the identity cache; the key may still be accepted for up to 60 seconds.',
    ]);
  });

  it('reports an unset REDIS_URL instead of purging', async () => {
    const { outcome, purged, lines } = revoke(undefined, {
      redisUrl: undefined,
    });

    await expect(outcome).resolves.toBe('revoked');
    expect(purged).toEqual([]);
    expect(lines).toEqual([
      'Revoked ak_01. REDIS_URL is unset, so the identity cache was not purged; the key may still be accepted for up to 60 seconds.',
    ]);
  });

  it.each([
    ['key_not_found', 'API key ak_01 was not found.'],
    ['actor_invalid', 'aihub-ops-alice is not an active AIHUB User Account.'],
  ] as const)('names %s without purging anything', async (kind, message) => {
    const { outcome, purged, lines, repository } = revoke({ kind });

    await expect(outcome).resolves.toBe(kind);
    expect(lines).toEqual([message]);
    expect(purged).toEqual([]);
    expect(repository.closed).toBe(true);
  });
});
