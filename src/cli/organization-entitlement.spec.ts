import type {
  GrantOrganizationEntitlementInput,
  GrantOrganizationEntitlementResult,
  OrganizationEntitlementPort,
} from '../modules/identity/application/organization-entitlement.port';
import { runGrantOrganizationEntitlementCommand } from './organization-entitlement';

class FakeRepository implements OrganizationEntitlementPort {
  readonly calls: GrantOrganizationEntitlementInput[] = [];
  closed = false;
  constructor(private readonly result: GrantOrganizationEntitlementResult) {}
  async grantEntitlement(input: GrantOrganizationEntitlementInput) {
    this.calls.push(input);
    return this.result;
  }
  async close() {
    this.closed = true;
  }
}

describe('runGrantOrganizationEntitlementCommand', () => {
  it('grants and purges organization API key caches', async () => {
    const repository = new FakeRepository({
      kind: 'granted',
      keyHashes: ['aa', 'bb'],
    });
    const purged: string[][] = [];
    const lines: string[] = [];
    const result = await runGrantOrganizationEntitlementCommand({
      databaseUrl: 'postgres://unused',
      redisUrl: 'redis://unused',
      organizationId: 'org_acme',
      actorUsername: 'aihub-ops-alice',
      entitlement: 'speaking',
      repository,
      purge: async (hashes) => {
        purged.push([...hashes]);
      },
      emit: (line) => lines.push(line),
      now: () => new Date('2026-09-23T10:00:00.000Z'),
    });

    expect(result).toBe('granted');
    expect(repository.calls[0]).toMatchObject({
      organizationId: 'org_acme',
      actorUsername: 'aihub-ops-alice',
      entitlement: 'speaking',
      occurredAt: new Date('2026-09-23T10:00:00.000Z'),
    });
    expect(repository.calls[0]?.requestId).toMatch(
      /^req_[0-9A-HJKMNP-TV-Z]{26}$/,
    );
    expect(purged).toEqual([['aa', 'bb']]);
    expect(lines.join('\n')).toContain(
      'Granted speaking to org_acme; recorded as req_',
    );
    expect(repository.closed).toBe(true);
  });

  it('rejects entitlements absent from the published operation catalog without opening the database', async () => {
    const repository = new FakeRepository({ kind: 'granted', keyHashes: [] });
    const lines: string[] = [];
    const result = await runGrantOrganizationEntitlementCommand({
      databaseUrl: 'postgres://unused',
      organizationId: 'org_acme',
      actorUsername: 'ops',
      entitlement: 'admin',
      repository,
      emit: (line) => lines.push(line),
    });
    expect(result).toBe('entitlement_invalid');
    expect(repository.calls).toEqual([]);
    expect(repository.closed).toBe(false);
    expect(lines[0]).toContain('Unknown entitlement admin');
  });

  it('does not fail a committed grant when Redis cannot be purged', async () => {
    const repository = new FakeRepository({
      kind: 'granted',
      keyHashes: ['aa'],
    });
    const lines: string[] = [];
    await expect(
      runGrantOrganizationEntitlementCommand({
        databaseUrl: 'postgres://unused',
        redisUrl: 'redis://unused',
        organizationId: 'org_acme',
        actorUsername: 'ops',
        entitlement: 'speaking',
        repository,
        purge: async () => {
          throw new Error('Redis unavailable');
        },
        emit: (line) => lines.push(line),
      }),
    ).resolves.toBe('granted');
    expect(lines.join('\n')).toContain('changes may take up to 60 seconds');
  });
});
