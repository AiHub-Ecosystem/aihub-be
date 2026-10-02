import type {
  OrganizationStatusPort,
  SetOrganizationStatusInput,
  SetOrganizationStatusResult,
} from '@/modules/identity/application/organization-status.port';

import {
  type OrganizationStatusCliInput,
  runOrganizationStatusCommand,
} from './organization-status';

class OrganizationStatusFake implements OrganizationStatusPort {
  readonly calls: SetOrganizationStatusInput[] = [];
  closed = false;

  constructor(private readonly result: SetOrganizationStatusResult) {}

  async setOrganizationStatus(
    input: SetOrganizationStatusInput,
  ): Promise<SetOrganizationStatusResult> {
    this.calls.push(input);
    return this.result;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function run(
  result: SetOrganizationStatusResult,
  overrides: Partial<OrganizationStatusCliInput> = {},
) {
  const repository = new OrganizationStatusFake(result);
  const purged: string[][] = [];
  const lines: string[] = [];
  const outcome = runOrganizationStatusCommand({
    databaseUrl: 'postgres://unused',
    redisUrl: 'redis://unused',
    organizationId: 'org_acme',
    actorUsername: 'aihub-ops-alice',
    status: 'suspended',
    repository,
    purge: async (hashes) => {
      purged.push([...hashes]);
    },
    emit: (line) => lines.push(line),
    now: () => new Date('2026-09-23T10:00:00.000Z'),
    ...overrides,
  });
  return { outcome, repository, purged, lines };
}

describe('runOrganizationStatusCommand', () => {
  it('suspends, names the request it recorded, and purges every key of the Organization', async () => {
    const { outcome, repository, purged, lines } = run({
      kind: 'changed',
      keyHashes: ['aa', 'bb'],
    });

    await expect(outcome).resolves.toBe('changed');
    const [call] = repository.calls;
    expect(call).toMatchObject({
      organizationId: 'org_acme',
      actorUsername: 'aihub-ops-alice',
      status: 'suspended',
      occurredAt: new Date('2026-09-23T10:00:00.000Z'),
    });
    expect(call?.requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(purged).toEqual([['aa', 'bb']]);
    expect(lines.join('\n')).toContain(
      `Suspended org_acme; recorded as ${call?.requestId}.`,
    );
    expect(lines.join('\n')).toContain(
      'Purged the identity cache of 2 API keys.',
    );
    expect(repository.closed).toBe(true);
  });

  it('restores with its own wording', async () => {
    const { outcome, lines } = run(
      { kind: 'changed', keyHashes: [] },
      { status: 'active' },
    );

    await expect(outcome).resolves.toBe('changed');
    expect(lines.join('\n')).toContain('Restored org_acme; recorded as req_');
  });

  it('reports a repeat as unchanged and still purges', async () => {
    const { outcome, purged, lines } = run({
      kind: 'unchanged',
      keyHashes: ['aa'],
    });

    await expect(outcome).resolves.toBe('unchanged');
    expect(lines.join('\n')).toContain(
      'org_acme is already suspended; nothing was recorded.',
    );
    expect(purged).toEqual([['aa']]);
  });

  it('keeps a committed act when the purge fails and says what that leaves open', async () => {
    const { outcome, lines } = run(
      { kind: 'changed', keyHashes: ['aa'] },
      {
        purge: async () => {
          throw new Error('redis down');
        },
      },
    );

    await expect(outcome).resolves.toBe('changed');
    expect(lines.join('\n')).toContain('Suspended org_acme');
    expect(lines.join('\n')).toContain(
      'identity cache was not purged; its API keys may keep their previous status for up to 60 seconds',
    );
  });

  it('reports an unset REDIS_URL instead of purging', async () => {
    const { outcome, purged, lines } = run(
      { kind: 'changed', keyHashes: ['aa'] },
      { redisUrl: undefined },
    );

    await expect(outcome).resolves.toBe('changed');
    expect(purged).toEqual([]);
    expect(lines.join('\n')).toContain('REDIS_URL is unset');
  });

  it.each([
    ['organization_not_found', 'Organization org_acme was not found.'],
    ['actor_invalid', 'aihub-ops-alice is not an active AIHUB User Account.'],
  ] as const)(
    'surfaces %s by name without purging anything',
    async (kind, message) => {
      const { outcome, purged, repository, lines } = run({ kind });

      await expect(outcome).resolves.toBe(kind);
      expect(lines).toEqual([message]);
      expect(purged).toEqual([]);
      expect(repository.closed).toBe(true);
    },
  );
});
