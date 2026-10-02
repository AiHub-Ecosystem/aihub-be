import type {
  AttachFirstOwnerInput,
  AttachFirstOwnerResult,
  OrganizationFirstOwnerPort,
} from '@/modules/identity/application/organization-first-owner.port';

import { runAttachFirstOwnerCommand } from './organization-first-owner';

class FirstOwnerFake implements OrganizationFirstOwnerPort {
  readonly calls: AttachFirstOwnerInput[] = [];
  closed = false;

  constructor(private readonly result: AttachFirstOwnerResult) {}

  async attachFirstOwner(
    input: AttachFirstOwnerInput,
  ): Promise<AttachFirstOwnerResult> {
    this.calls.push(input);
    return this.result;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function run(kind: AttachFirstOwnerResult['kind']) {
  const repository = new FirstOwnerFake({ kind });
  const lines: string[] = [];
  const outcome = await runAttachFirstOwnerCommand({
    databaseUrl: 'postgres://unused',
    organizationId: 'org_acme',
    ownerUsername: 'acme-owner',
    actorUsername: 'aihub-ops-alice',
    repository,
    emit: (line) => lines.push(line),
    now: () => new Date('2026-09-23T10:00:00.000Z'),
  });
  return { outcome, repository, lines };
}

describe('runAttachFirstOwnerCommand', () => {
  it('attaches and names the request it recorded', async () => {
    const { outcome, repository, lines } = await run('attached');

    expect(outcome).toBe('attached');
    const [call] = repository.calls;
    expect(call).toMatchObject({
      organizationId: 'org_acme',
      ownerUsername: 'acme-owner',
      actorUsername: 'aihub-ops-alice',
      occurredAt: new Date('2026-09-23T10:00:00.000Z'),
    });
    expect(call?.requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(lines).toEqual([
      `Attached acme-owner as owner of org_acme; recorded as ${call?.requestId}.`,
    ]);
    expect(repository.closed).toBe(true);
  });

  it.each([
    [
      'unchanged',
      'acme-owner is already the owner of org_acme; nothing was recorded.',
    ],
    ['organization_not_found', 'Organization org_acme was not found.'],
    [
      'owner_invalid',
      'acme-owner is not an AIHUB User Account that can be attached.',
    ],
    ['actor_invalid', 'aihub-ops-alice is not an active AIHUB User Account.'],
    [
      'actor_is_owner',
      'aihub-ops-alice cannot attach their own account; another operator must run this.',
    ],
    [
      'organization_has_members',
      'org_acme already has an active member; use an invitation instead.',
    ],
  ] as const)('reports %s by name', async (kind, message) => {
    const { outcome, lines, repository } = await run(kind);

    expect(outcome).toBe(kind);
    expect(lines).toEqual([message]);
    expect(repository.closed).toBe(true);
  });
});
