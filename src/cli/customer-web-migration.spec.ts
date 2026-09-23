import {
  type MigrationPlanInput,
  buildEvidence,
  deriveUsername,
  planCustomerWebMigration,
} from './customer-web-migration';

function input(
  overrides: Partial<MigrationPlanInput> = {},
): MigrationPlanInput {
  return {
    clerkUsers: [],
    clerkInvitations: [],
    existingAccounts: [],
    existingMemberships: [],
    ownerEmails: [],
    dispositions: {},
    ...overrides,
  };
}

describe('planCustomerWebMigration', () => {
  it('links an active Clerk user to the exact active account by normalized email', () => {
    const plan = planCustomerWebMigration(
      input({
        clerkUsers: [
          {
            clerkUserId: 'clerk_1',
            email: '  Person@Example.COM ',
            membershipStatus: 'active',
          },
        ],
        existingAccounts: [
          {
            accountId: 'usr_ACT',
            canonicalEmail: 'person@example.com',
            status: 'active',
          },
        ],
      }),
    );

    expect(plan.decisions).toEqual([
      {
        kind: 'link_account',
        clerkUserId: 'clerk_1',
        email: 'person@example.com',
        accountId: 'usr_ACT',
        membership: { role: 'member', status: 'active' },
      },
    ]);
    expect(plan.readyToFlip).toBe(true);
  });

  it('creates an account when no match exists, planned as an active member', () => {
    const plan = planCustomerWebMigration(
      input({
        clerkUsers: [
          {
            clerkUserId: 'clerk_1',
            email: 'new@example.com',
            membershipStatus: 'active',
          },
        ],
      }),
    );

    expect(plan.decisions).toEqual([
      {
        kind: 'create_account',
        clerkUserId: 'clerk_1',
        email: 'new@example.com',
        membership: { role: 'member', status: 'active' },
      },
    ]);
  });

  it('quarantines a user without an email', () => {
    const plan = planCustomerWebMigration(
      input({
        clerkUsers: [
          { clerkUserId: 'clerk_1', email: null, membershipStatus: 'active' },
        ],
      }),
    );

    expect(plan.decisions).toEqual([
      {
        kind: 'quarantine',
        clerkUserId: 'clerk_1',
        email: null,
        reason: 'missing_email',
      },
    ]);
    expect(plan.readyToFlip).toBe(false);
  });

  it('quarantines both users when two Clerk users normalize to one email', () => {
    const plan = planCustomerWebMigration(
      input({
        clerkUsers: [
          {
            clerkUserId: 'clerk_1',
            email: 'dup@example.com',
            membershipStatus: 'active',
          },
          {
            clerkUserId: 'clerk_2',
            email: 'DUP@example.com',
            membershipStatus: 'active',
          },
        ],
      }),
    );

    expect(plan.decisions).toEqual([
      {
        kind: 'quarantine',
        clerkUserId: 'clerk_1',
        email: 'dup@example.com',
        reason: 'duplicate_clerk_email',
      },
      {
        kind: 'quarantine',
        clerkUserId: 'clerk_2',
        email: 'dup@example.com',
        reason: 'duplicate_clerk_email',
      },
    ]);
    expect(plan.readyToFlip).toBe(false);
  });

  it('quarantines an email match whose account is not active', () => {
    const plan = planCustomerWebMigration(
      input({
        clerkUsers: [
          {
            clerkUserId: 'clerk_1',
            email: 'pending@example.com',
            membershipStatus: 'active',
          },
        ],
        existingAccounts: [
          {
            accountId: 'usr_PEND',
            canonicalEmail: 'pending@example.com',
            status: 'pending_verification',
          },
        ],
      }),
    );

    expect(plan.decisions).toEqual([
      {
        kind: 'quarantine',
        clerkUserId: 'clerk_1',
        email: 'pending@example.com',
        reason: 'account_not_active',
      },
    ]);
  });

  it('plans a disabled membership for a disabled Clerk member', () => {
    const plan = planCustomerWebMigration(
      input({
        clerkUsers: [
          {
            clerkUserId: 'clerk_1',
            email: 'off@example.com',
            membershipStatus: 'disabled',
          },
        ],
      }),
    );

    expect(plan.decisions[0]).toMatchObject({
      kind: 'create_account',
      membership: { role: 'member', status: 'disabled' },
    });
  });

  it('promotes a designated active owner', () => {
    const plan = planCustomerWebMigration(
      input({
        clerkUsers: [
          {
            clerkUserId: 'clerk_1',
            email: 'Boss@Example.com',
            membershipStatus: 'active',
          },
        ],
        ownerEmails: ['boss@example.com'],
      }),
    );

    expect(plan.decisions[0]).toMatchObject({
      kind: 'create_account',
      membership: { role: 'owner', status: 'active' },
    });
  });

  it('quarantines a designated owner whose Clerk membership is disabled', () => {
    const plan = planCustomerWebMigration(
      input({
        clerkUsers: [
          {
            clerkUserId: 'clerk_1',
            email: 'boss@example.com',
            membershipStatus: 'disabled',
          },
        ],
        ownerEmails: ['boss@example.com'],
      }),
    );

    expect(plan.decisions).toEqual([
      {
        kind: 'quarantine',
        clerkUserId: 'clerk_1',
        email: 'boss@example.com',
        reason: 'owner_disabled',
      },
    ]);
  });

  it('is a no-op when the existing membership row already matches the plan', () => {
    const plan = planCustomerWebMigration(
      input({
        clerkUsers: [
          {
            clerkUserId: 'clerk_1',
            email: 'done@example.com',
            membershipStatus: 'active',
          },
        ],
        existingAccounts: [
          {
            accountId: 'usr_DONE',
            canonicalEmail: 'done@example.com',
            status: 'active',
          },
        ],
        existingMemberships: [
          { accountId: 'usr_DONE', role: 'member', status: 'active' },
        ],
      }),
    );

    expect(plan.decisions).toEqual([
      {
        kind: 'membership_noop',
        clerkUserId: 'clerk_1',
        email: 'done@example.com',
        accountId: 'usr_DONE',
      },
    ]);
    expect(plan.readyToFlip).toBe(true);
  });

  it('quarantines when the existing membership row differs from the plan', () => {
    const plan = planCustomerWebMigration(
      input({
        clerkUsers: [
          {
            clerkUserId: 'clerk_1',
            email: 'mismatch@example.com',
            membershipStatus: 'active',
          },
        ],
        existingAccounts: [
          {
            accountId: 'usr_MIS',
            canonicalEmail: 'mismatch@example.com',
            status: 'active',
          },
        ],
        existingMemberships: [
          { accountId: 'usr_MIS', role: 'owner', status: 'active' },
        ],
      }),
    );

    expect(plan.decisions).toEqual([
      {
        kind: 'quarantine',
        clerkUserId: 'clerk_1',
        email: 'mismatch@example.com',
        reason: 'membership_mismatch',
      },
    ]);
  });

  it('resolves quarantine through operator dispositions (skip and link)', () => {
    const base = {
      clerkUsers: [
        {
          clerkUserId: 'clerk_1',
          email: 'mismatch@example.com',
          membershipStatus: 'active' as const,
        },
      ],
      existingAccounts: [
        {
          accountId: 'usr_MIS',
          canonicalEmail: 'mismatch@example.com',
          status: 'active' as const,
        },
      ],
      existingMemberships: [
        {
          accountId: 'usr_MIS',
          role: 'owner' as const,
          status: 'active' as const,
        },
      ],
    };

    const skipped = planCustomerWebMigration(
      input({ ...base, dispositions: { clerk_1: { kind: 'skip' } } }),
    );
    expect(skipped.decisions).toEqual([
      { kind: 'skip', clerkUserId: 'clerk_1', email: 'mismatch@example.com' },
    ]);
    expect(skipped.readyToFlip).toBe(true);

    const linked = planCustomerWebMigration(
      input({
        ...base,
        dispositions: { clerk_1: { kind: 'link', accountId: 'usr_MIS' } },
      }),
    );
    expect(linked.decisions[0]).toMatchObject({
      kind: 'link_account',
      accountId: 'usr_MIS',
      membership: { role: 'member', status: 'active' },
    });
    expect(linked.readyToFlip).toBe(true);
  });

  it('refuses a create disposition when the email already has an account row', () => {
    const plan = planCustomerWebMigration(
      input({
        clerkUsers: [
          {
            clerkUserId: 'clerk_1',
            email: 'pending@example.com',
            membershipStatus: 'active',
          },
        ],
        existingAccounts: [
          {
            accountId: 'usr_PEND',
            canonicalEmail: 'pending@example.com',
            status: 'pending_verification',
          },
        ],
        dispositions: { clerk_1: { kind: 'create' } },
      }),
    );

    expect(plan.decisions[0]).toMatchObject({
      kind: 'quarantine',
      reason: 'account_exists',
    });
    expect(plan.readyToFlip).toBe(false);
  });

  it('reissues invitations only when the email will not hold an active membership', () => {
    const plan = planCustomerWebMigration(
      input({
        clerkUsers: [
          {
            clerkUserId: 'clerk_1',
            email: 'member@example.com',
            membershipStatus: 'active',
          },
          {
            clerkUserId: 'clerk_2',
            email: 'off@example.com',
            membershipStatus: 'disabled',
          },
        ],
        clerkInvitations: [
          { email: 'Member@example.com', role: 'member' },
          { email: 'off@example.com', role: 'member' },
          { email: 'unknown@example.com', role: 'member' },
          { email: 'UNKNOWN@example.com', role: 'admin' },
        ],
      }),
    );

    expect(plan.invitesToReissue).toEqual([
      { email: 'off@example.com', role: 'member' },
      { email: 'unknown@example.com', role: 'member' },
    ]);
  });

  it('aggregates counts and flips only when quarantine is empty', () => {
    const plan = planCustomerWebMigration(
      input({
        clerkUsers: [
          {
            clerkUserId: 'clerk_1',
            email: 'a@example.com',
            membershipStatus: 'active',
          },
          {
            clerkUserId: 'clerk_2',
            email: 'b@example.com',
            membershipStatus: 'active',
          },
          { clerkUserId: 'clerk_3', email: null, membershipStatus: 'active' },
        ],
        clerkInvitations: [{ email: 'c@example.com', role: 'member' }],
      }),
    );

    expect(plan.counts).toEqual({
      clerkUsers: 3,
      created: 2,
      linked: 0,
      membershipNoops: 0,
      skipped: 0,
      quarantine: 1,
      invitesToReissue: 1,
    });
    expect(plan.readyToFlip).toBe(false);
  });
});

describe('buildEvidence', () => {
  const counts = {
    clerkUsers: 2,
    created: 1,
    linked: 0,
    membershipNoops: 0,
    skipped: 0,
    quarantine: 1,
    invitesToReissue: 0,
  };

  it('produces identical canonical text and digest regardless of key order', () => {
    const a = buildEvidence({
      counts: { ...counts },
      mapping: [
        {
          clerkUserId: 'clerk_1',
          email: 'a@example.com',
          accountId: 'usr_A',
          decision: 'create_account',
        },
      ],
    });
    const reordered = buildEvidence({
      mapping: [
        {
          decision: 'create_account',
          accountId: 'usr_A',
          email: 'a@example.com',
          clerkUserId: 'clerk_1',
        },
      ],
      counts: {
        invitesToReissue: 0,
        quarantine: 1,
        skipped: 0,
        membershipNoops: 0,
        linked: 0,
        created: 1,
        clerkUsers: 2,
      },
    } as never);

    expect(reordered.text).toBe(a.text);
    expect(reordered.digest).toBe(a.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the digest when mapping content changes', () => {
    const a = buildEvidence({
      counts,
      mapping: [
        {
          clerkUserId: 'clerk_1',
          email: 'a@example.com',
          accountId: 'usr_A',
          decision: 'create_account',
        },
      ],
    });
    const b = buildEvidence({
      counts,
      mapping: [
        {
          clerkUserId: 'clerk_1',
          email: 'a@example.com',
          accountId: 'usr_B',
          decision: 'create_account',
        },
      ],
    });

    expect(b.digest).not.toBe(a.digest);
  });
});

describe('deriveUsername', () => {
  it('derives a deterministic username within the 3-32 column bounds', () => {
    const first = deriveUsername('jo.smith@example.com', 'clerk_1', new Set());
    const second = deriveUsername('jo.smith@example.com', 'clerk_1', new Set());

    expect(first).toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(first.length).toBeLessThanOrEqual(32);
    expect(first).toMatch(/^[a-z0-9-]+$/);
  });

  it('never collides with a taken username by adding a stable suffix', () => {
    const base = deriveUsername('jo.smith@example.com', 'clerk_1', new Set());
    const taken = deriveUsername(
      'jo.smith@example.com',
      'clerk_1',
      new Set([base]),
    );

    expect(taken).not.toBe(base);
    expect(taken.startsWith(`${base}-`)).toBe(true);
    expect(taken.length).toBeLessThanOrEqual(32);
  });

  it('stays at least three characters for very short local parts', () => {
    expect(
      deriveUsername('a@b.co', 'clerk_1', new Set()).length,
    ).toBeGreaterThanOrEqual(3);
  });
});
