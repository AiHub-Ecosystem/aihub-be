import { runCustomerWebMigrationCommand } from './customer-web-migration';

function fakePorts(
  overrides: Partial<
    Parameters<typeof runCustomerWebMigrationCommand>[0]['ports']
  > = {},
) {
  const applied: string[] = [];
  return {
    applied,
    ports: {
      loadState: async () => ({
        existingAccounts: [],
        existingMemberships: [],
        takenUsernames: new Set<string>(),
      }),
      createAccount: async (input: { email: string; username: string }) => {
        applied.push(`create:${input.email}:${input.username}`);
        return `usr_NEW_${input.email}`;
      },
      upsertMembership: async (input: {
        accountId: string;
        role: string;
        status: string;
      }) => {
        applied.push(
          `membership:${input.accountId}:${input.role}:${input.status}`,
        );
      },
      hashPassword: async () =>
        '$argon2id$v=19$m=65536,t=3,p=1$fakefakefakefakefakefakefakefake$fakefakefakefakefakefakefakefakefakefake',
      writeEvidence: async () => undefined,
      emit: () => undefined,
      ...overrides,
    },
  };
}

const baseExport = {
  clerkUsers: [
    {
      clerkUserId: 'clerk_1',
      email: 'boss@example.com',
      membershipStatus: 'active' as const,
    },
    {
      clerkUserId: 'clerk_2',
      email: 'member@example.com',
      membershipStatus: 'active' as const,
    },
    {
      clerkUserId: 'clerk_3',
      email: null,
      membershipStatus: 'active' as const,
    },
  ],
  clerkInvitations: [],
};

describe('runCustomerWebMigrationCommand', () => {
  it('dry-run plans without touching the database', async () => {
    const { ports, applied } = fakePorts();

    const outcome = await runCustomerWebMigrationCommand({
      clerkExport: baseExport,
      organizationId: 'org_sandbox',
      ownerEmails: ['boss@example.com'],
      dispositions: {},
      dryRun: true,
      evidencePath: 'out/evidence.json',
      ports,
    });

    expect(outcome).toBe('dry_run');
    expect(applied).toEqual([]);
  });

  it('refuses to apply while quarantine entries remain unresolved', async () => {
    const { ports, applied } = fakePorts();

    const outcome = await runCustomerWebMigrationCommand({
      clerkExport: baseExport,
      organizationId: 'org_sandbox',
      ownerEmails: [],
      dispositions: {},
      dryRun: false,
      evidencePath: 'out/evidence.json',
      ports,
    });

    expect(outcome).toBe('blocked_quarantine');
    expect(applied).toEqual([]);
  });

  it('applies owners before ordinary members and writes evidence', async () => {
    const { ports, applied } = fakePorts();
    const evidenceWrites: string[] = [];
    ports.writeEvidence = async (text: string) => {
      evidenceWrites.push(text);
    };

    const outcome = await runCustomerWebMigrationCommand({
      clerkExport: baseExport,
      organizationId: 'org_sandbox',
      ownerEmails: ['boss@example.com'],
      dispositions: { clerk_3: { kind: 'skip' } },
      dryRun: false,
      evidencePath: 'out/evidence.json',
      ports,
    });

    expect(outcome).toBe('applied');
    const ownerIndex = applied.findIndex((line) =>
      line.includes(':owner:active'),
    );
    const memberIndex = applied.findIndex((line) =>
      line.includes(':member:active'),
    );
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
    expect(memberIndex).toBeGreaterThan(ownerIndex);
    expect(
      applied.some((line) => line.startsWith('create:boss@example.com')),
    ).toBe(true);
    expect(evidenceWrites).toHaveLength(1);
    expect(evidenceWrites[0]).toContain('"clerk_1"');
  });

  it('is a no-op apply on an already-migrated export (idempotent re-run)', async () => {
    const first = fakePorts();
    await runCustomerWebMigrationCommand({
      clerkExport: {
        clerkUsers: [
          {
            clerkUserId: 'clerk_2',
            email: 'member@example.com',
            membershipStatus: 'active',
          },
        ],
        clerkInvitations: [],
      },
      organizationId: 'org_sandbox',
      ownerEmails: [],
      dispositions: {},
      dryRun: true,
      evidencePath: 'out/1.json',
      ports: first.ports,
    });

    const { ports, applied } = fakePorts({
      loadState: async () => ({
        existingAccounts: [
          {
            accountId: 'usr_EXIST',
            canonicalEmail: 'member@example.com',
            status: 'active' as const,
          },
        ],
        existingMemberships: [
          {
            accountId: 'usr_EXIST',
            role: 'member' as const,
            status: 'active' as const,
          },
        ],
        takenUsernames: new Set<string>(['memberexample']),
      }),
    });

    const outcome = await runCustomerWebMigrationCommand({
      clerkExport: {
        clerkUsers: [
          {
            clerkUserId: 'clerk_2',
            email: 'member@example.com',
            membershipStatus: 'active',
          },
        ],
        clerkInvitations: [],
      },
      organizationId: 'org_sandbox',
      ownerEmails: [],
      dispositions: {},
      dryRun: false,
      evidencePath: 'out/2.json',
      ports,
    });

    expect(outcome).toBe('applied');
    expect(applied).toEqual([]);
  });
});
