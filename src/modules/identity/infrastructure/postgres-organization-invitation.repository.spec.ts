import { AppError } from '../../../common/errors/app-error';
import { createRequestContext } from '../../../common/request-context/request-context.factory';
import type {
  AcceptOrganizationInvitationInput,
  CreateOrganizationInvitationInput,
  ListOpenOrganizationInvitationsInput,
} from '../application/organization-invitation.port';

import type {
  PostgresIdentityQueryClient,
  PostgresIdentityTransactionalClient,
} from './postgres-identity.client';
import { PostgresOrganizationInvitationRepository } from './postgres-organization-invitation.repository';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const INVITATION_ID = 'oiv_01J00000000000000000000000';
const TOKEN_HASH = 'a'.repeat(64);
const NOW = new Date('2026-09-21T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-09-22T00:00:00.000Z');

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function client(
  rowsFor: (text: string) => readonly unknown[],
  recorded: RecordedQuery[] = [],
  options: { readonly failTransaction?: boolean } = {},
): PostgresIdentityTransactionalClient {
  const query = async (text: string, values: readonly unknown[]) => {
    recorded.push({ text, values });
    return rowsFor(text);
  };
  const transactionClient: PostgresIdentityQueryClient = { query };

  return {
    query,
    transaction: async (callback) => {
      if (options.failTransaction === true) {
        throw new Error('connection reset');
      }
      return callback(transactionClient);
    },
  };
}

function rows(options: {
  readonly activeMembership: boolean;
  readonly supersededOpenInvitation?: boolean;
}) {
  return (text: string): readonly unknown[] => {
    if (text.includes('FROM organizations')) {
      return [{ id: ORGANIZATION_ID, name: 'Acme' }];
    }
    if (text.includes('FROM organization_members')) {
      return options.activeMembership ? [{ '?column?': 1 }] : [];
    }
    if (text.includes('UPDATE organization_invitations')) {
      return options.supersededOpenInvitation === true
        ? [{ id: 'oiv_01J0000000000000000000000Z' }]
        : [];
    }
    return [];
  };
}

function input(
  overrides: Partial<CreateOrganizationInvitationInput> = {},
): CreateOrganizationInvitationInput {
  return {
    context: createRequestContext({
      requestId: 'req_01J00000000000000000000000',
      receivedAt: NOW,
      deadlineMs: 5_000,
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      scopes: [],
    }),
    invitationId: INVITATION_ID,
    organizationId: ORGANIZATION_ID,
    email: 'invitee@example.com',
    role: 'member',
    invitedBy: USER_ID,
    tokenHash: TOKEN_HASH,
    expiresAt: EXPIRES_AT,
    now: NOW,
    ...overrides,
  };
}

function listInput(
  overrides: Partial<ListOpenOrganizationInvitationsInput> = {},
): ListOpenOrganizationInvitationsInput {
  return {
    context: createRequestContext({
      requestId: 'req_01J00000000000000000000000',
      receivedAt: NOW,
      deadlineMs: 5_000,
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      scopes: [],
    }),
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    now: NOW,
    ...overrides,
  };
}

describe('PostgresOrganizationInvitationRepository', () => {
  it('lists open invitations as redacted metadata in deterministic order', async () => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(
        () => [
          {
            id: INVITATION_ID,
            email: 'invitee@example.com',
            role: 'admin',
            invited_by_username: 'owner',
            created_at: new Date('2026-09-21T11:00:00.000Z'),
            expires_at: new Date('2026-09-22T11:00:00.000Z'),
          },
        ],
        recorded,
      ),
    );

    await expect(repository.listOpenInvitations(listInput())).resolves.toEqual([
      {
        invitationId: INVITATION_ID,
        email: 'invitee@example.com',
        role: 'admin',
        invitedByUsername: 'owner',
        createdAt: new Date('2026-09-21T11:00:00.000Z'),
        expiresAt: new Date('2026-09-22T11:00:00.000Z'),
      },
    ]);

    const query = recorded[0];
    expect(query?.values).toEqual([ORGANIZATION_ID, NOW]);
    expect(query?.text).toContain('consumed_at IS NULL');
    expect(query?.text).toContain('expires_at > $2');
    expect(query?.text).toContain('LEFT JOIN user_accounts');
    expect(query?.text).toContain('ORDER BY invitation.created_at DESC');
    expect(query?.text).toContain('invitation.id ASC');
    expect(query?.text).not.toContain('token_hash');
    expect(query?.text).not.toContain('account.status');
  });

  it('fails the whole listing when the issuer projection is invalid', async () => {
    const repository = new PostgresOrganizationInvitationRepository(
      client(() => [
        {
          id: INVITATION_ID,
          email: 'invitee@example.com',
          role: 'member',
          invited_by_username: null,
          created_at: NOW,
          expires_at: EXPIRES_AT,
        },
      ]),
    );

    await expect(
      repository.listOpenInvitations(listInput()),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('fails closed when the durable listing is unavailable', async () => {
    const repository = new PostgresOrganizationInvitationRepository(
      client(() => {
        throw new Error('connection reset');
      }),
    );

    await expect(
      repository.listOpenInvitations(listInput()),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Identity store is unavailable',
    });
  });

  it.each([
    ['a caller that is not the request context user', { userId: 'usr_other' }],
    [
      'an organization that is not in the request context',
      { organizationId: 'org_other' },
    ],
    ['an invalid current time', { now: new Date(Number.NaN) }],
  ])('rejects %s before touching the store', async (_label, overrides) => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(() => [], recorded),
    );

    await expect(
      repository.listOpenInvitations(listInput(overrides)),
    ).rejects.toBeInstanceOf(AppError);
    expect(recorded).toHaveLength(0);
  });

  it('supersedes the previous open invitation and inserts the replacement in one transaction', async () => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(rows({ activeMembership: false }), recorded),
    );

    const result = await repository.createInvitation(input());

    expect(result).toEqual({ kind: 'created', organizationName: 'Acme' });

    const statements = recorded.map(({ text }) => text.trim().split(/\s+/)[0]);
    expect(statements).toEqual([
      'SELECT',
      'SELECT',
      'UPDATE',
      'INSERT',
      'INSERT',
    ]);

    const close = recorded[2];
    expect(close?.text).toContain('consumed_at IS NULL');
    expect(close?.values).toEqual([
      ORGANIZATION_ID,
      'invitee@example.com',
      NOW,
    ]);

    const insert = recorded[3];
    expect(insert?.text).toContain('INSERT INTO organization_invitations');
    expect(insert?.values).toEqual([
      INVITATION_ID,
      ORGANIZATION_ID,
      'invitee@example.com',
      'member',
      USER_ID,
      TOKEN_HASH,
      EXPIRES_AT,
      NOW,
    ]);
  });

  it('locks the organization before it decides anything', async () => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(rows({ activeMembership: false }), recorded),
    );

    await repository.createInvitation(input());

    expect(recorded[0]?.text).toContain('FOR UPDATE');
  });

  it('reports a conflict for an email that already holds an active membership', async () => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(rows({ activeMembership: true }), recorded),
    );

    const result = await repository.createInvitation(input());

    expect(result).toEqual({ kind: 'member_exists' });
    // Nothing durable is written for a conflict.
    expect(recorded.map(({ text }) => text.trim().split(/\s+/)[0])).toEqual([
      'SELECT',
      'SELECT',
    ]);
  });

  it('only treats an active membership as a conflict', async () => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(rows({ activeMembership: false }), recorded),
    );

    await repository.createInvitation(input());

    // A disabled membership, a pending-verification account, a disabled
    // account, and an unknown email are all invitable: the conflict probe is
    // narrowed to an active membership rather than to the account's existence.
    const probe = recorded[1]?.text ?? '';
    expect(probe).toContain("membership.status = 'active'");
    expect(probe).not.toContain('user_accounts');
  });

  it('matches the invited email against the durable canonical email', async () => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(rows({ activeMembership: false }), recorded),
    );

    await repository.createInvitation(input());

    expect(recorded[1]?.text).toContain('identity.canonical_email = $2');
    expect(recorded[1]?.values).toEqual([
      ORGANIZATION_ID,
      'invitee@example.com',
    ]);
  });

  it.each([
    [
      'a caller that is not the request context user',
      { invitedBy: 'usr_other' },
    ],
    [
      'an organization the request context does not name',
      { organizationId: 'org_other' },
    ],
    ['a token hash that is not sha-256 hex', { tokenHash: 'not-a-hash' }],
    ['an expiry at or before issuance', { expiresAt: NOW }],
    ['an empty email', { email: '   ' }],
  ])('rejects %s', async (_label, overrides) => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(rows({ activeMembership: false }), recorded),
    );

    await expect(
      repository.createInvitation(input(overrides)),
    ).rejects.toBeInstanceOf(AppError);
    expect(recorded).toHaveLength(0);
  });

  it('fails closed without exposing the driver failure', async () => {
    const repository = new PostgresOrganizationInvitationRepository(
      client(rows({ activeMembership: false }), [], { failTransaction: true }),
    );

    await expect(repository.createInvitation(input())).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Identity store is unavailable',
    });
  });

  it('rejects an organization row it cannot map', async () => {
    const repository = new PostgresOrganizationInvitationRepository(
      client(() => []),
    );

    await expect(repository.createInvitation(input())).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});

describe('PostgresOrganizationInvitationRepository acceptance', () => {
  function acceptRows(
    options: {
      readonly noInvitation?: boolean;
      readonly organizationStatus?: string;
      readonly callerEmail?: string;
      readonly noCallerIdentity?: boolean;
      readonly grantedRole?: string;
    } = {},
  ) {
    const {
      noInvitation = false,
      organizationStatus = 'active',
      callerEmail = 'invitee@example.com',
      noCallerIdentity = false,
      grantedRole = 'member',
    } = options;

    return (text: string): readonly unknown[] => {
      if (text.includes('FROM organization_invitations')) {
        return noInvitation
          ? []
          : [
              {
                id: INVITATION_ID,
                organization_id: ORGANIZATION_ID,
                email: 'invitee@example.com',
                role: 'member',
              },
            ];
      }
      if (text.includes('FROM organizations')) {
        return [
          {
            organization_status: organizationStatus,
            canonical_email: noCallerIdentity ? null : callerEmail,
          },
        ];
      }
      if (text.includes('INSERT INTO organization_members')) {
        return [{ role: grantedRole }];
      }
      return [];
    };
  }

  function acceptInput(
    overrides: Partial<AcceptOrganizationInvitationInput> = {},
  ): AcceptOrganizationInvitationInput {
    return {
      context: createRequestContext({
        requestId: 'req_01J00000000000000000000000',
        receivedAt: NOW,
        deadlineMs: 5_000,
        userId: USER_ID,
        scopes: [],
      }),
      userId: USER_ID,
      tokenHash: TOKEN_HASH,
      now: NOW,
      ...overrides,
    };
  }

  function statements(recorded: RecordedQuery[]): string[] {
    return recorded.map(({ text }) => text.trim().split(/\s+/)[0] ?? '');
  }

  it('locks the invitation, grants the membership, and consumes the token in one transaction', async () => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(acceptRows(), recorded),
    );

    const result = await repository.acceptInvitation(acceptInput());

    expect(result).toEqual({
      kind: 'accepted',
      organizationId: ORGANIZATION_ID,
      role: 'member',
    });
    expect(statements(recorded)).toContain('INSERT');
    expect(statements(recorded)).toContain('UPDATE');

    const lock = recorded[0];
    expect(lock?.text).toContain('FOR UPDATE');
    expect(lock?.text).toContain('consumed_at IS NULL');
    expect(lock?.text).toContain('expires_at > $2');
    expect(lock?.values).toEqual([TOKEN_HASH, NOW]);

    const consume = recorded[3];
    expect(consume?.text).toContain('SET consumed_at = $2');
    expect(consume?.values).toEqual([TOKEN_HASH, NOW]);
  });

  it('takes the invitation role only for a disabled membership', async () => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(acceptRows(), recorded),
    );

    await repository.acceptInvitation(acceptInput());

    const upsert = recorded[2]?.text ?? '';
    expect(upsert).toContain('ON CONFLICT (organization_id, user_account_id)');
    expect(upsert).toContain("WHEN organization_members.status = 'disabled'");
    expect(upsert).toContain('THEN EXCLUDED.role');
    expect(upsert).toContain('ELSE organization_members.role');
  });

  it('returns the role the membership actually ended up with', async () => {
    const repository = new PostgresOrganizationInvitationRepository(
      client(acceptRows({ grantedRole: 'owner' })),
    );

    // An already-active owner keeps owner even though the invitation named
    // member: the database decides, and the caller is told the truth.
    await expect(repository.acceptInvitation(acceptInput())).resolves.toEqual({
      kind: 'accepted',
      organizationId: ORGANIZATION_ID,
      role: 'owner',
    });
  });

  it('resolves the organization status and caller email in the same transaction', async () => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(acceptRows(), recorded),
    );

    await repository.acceptInvitation(acceptInput());

    const probe = recorded[1];
    expect(probe?.text).toContain('canonical_email');
    expect(probe?.text).toContain("identity.provider = 'password'");
    expect(probe?.values).toEqual([ORGANIZATION_ID, USER_ID]);
  });

  it.each([
    [
      'an unknown, expired, consumed, or superseded token',
      { noInvitation: true },
    ],
    ['a token issued for another email', { callerEmail: 'someone@else.test' }],
    ['an account with no password identity', { noCallerIdentity: true }],
  ])('rejects %s without consuming anything', async (_label, overrides) => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(acceptRows(overrides), recorded),
    );

    const result = await repository.acceptInvitation(acceptInput());

    expect(result).toEqual({ kind: 'token_invalid' });
    expect(statements(recorded)).not.toContain('INSERT');
    expect(statements(recorded)).not.toContain('UPDATE');
  });

  it('rejects a suspended organization without consuming anything', async () => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(acceptRows({ organizationStatus: 'suspended' }), recorded),
    );

    const result = await repository.acceptInvitation(acceptInput());

    expect(result).toEqual({ kind: 'organization_suspended' });
    expect(statements(recorded)).not.toContain('INSERT');
    expect(statements(recorded)).not.toContain('UPDATE');
  });

  it.each([
    ['a caller that is not the request context user', { userId: 'usr_other' }],
    ['a token hash that is not sha-256 hex', { tokenHash: 'not-a-hash' }],
  ])('rejects %s before touching the store', async (_label, overrides) => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(acceptRows(), recorded),
    );

    await expect(
      repository.acceptInvitation(acceptInput(overrides)),
    ).rejects.toBeInstanceOf(AppError);
    expect(recorded).toHaveLength(0);
  });

  it('rejects a request context that names an organization', async () => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(acceptRows(), recorded),
    );

    // The organization comes from the invitation; a caller-named one has no
    // meaning here and must not be silently ignored.
    await expect(
      repository.acceptInvitation(
        acceptInput({
          context: createRequestContext({
            requestId: 'req_01J00000000000000000000000',
            receivedAt: NOW,
            deadlineMs: 5_000,
            organizationId: ORGANIZATION_ID,
            userId: USER_ID,
            scopes: [],
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(recorded).toHaveLength(0);
  });

  it('fails closed without exposing the driver failure', async () => {
    const repository = new PostgresOrganizationInvitationRepository(
      client(acceptRows(), [], { failTransaction: true }),
    );

    await expect(
      repository.acceptInvitation(acceptInput()),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Identity store is unavailable',
    });
  });

  it('records an acceptance with the role the membership actually took', async () => {
    const recorded: RecordedQuery[] = [];
    await new PostgresOrganizationInvitationRepository(
      client(acceptRows({ grantedRole: 'admin' }), recorded),
    ).acceptInvitation(acceptInput());

    const write = recorded.find(({ text }) =>
      text.includes('INSERT INTO organization_audit_events'),
    );
    expect(write?.values[3]).toBe('invitation.accepted');
    expect(write?.values[6]).toBe(INVITATION_ID);
    expect(write?.values[8]).toBe(JSON.stringify({ role: 'admin' }));
  });

  it('records nothing for a token it refuses', async () => {
    const recorded: RecordedQuery[] = [];
    await new PostgresOrganizationInvitationRepository(
      client(acceptRows({ noInvitation: true }), recorded),
    ).acceptInvitation(acceptInput());

    expect(
      recorded.some(({ text }) => text.includes('organization_audit_events')),
    ).toBe(false);
  });
});

describe('PostgresOrganizationInvitationRepository audit trail', () => {
  function auditWrite(recorded: RecordedQuery[]) {
    return recorded.find(({ text }) =>
      text.includes('INSERT INTO organization_audit_events'),
    );
  }

  it('records a first invitation as sent, labelled by the invited email', async () => {
    const recorded: RecordedQuery[] = [];
    await new PostgresOrganizationInvitationRepository(
      client(rows({ activeMembership: false }), recorded),
    ).createInvitation(input());

    expect(auditWrite(recorded)?.values).toEqual([
      expect.stringMatching(/^oae_[0-9A-HJKMNP-TV-Z]{26}$/),
      ORGANIZATION_ID,
      USER_ID,
      'invitation.sent',
      'applied',
      'invitation',
      INVITATION_ID,
      'invitee@example.com',
      JSON.stringify({ role: 'member' }),
      'req_01J00000000000000000000000',
      NOW,
    ]);
  });

  it('records a resend separately from the invitation it superseded', async () => {
    const recorded: RecordedQuery[] = [];
    await new PostgresOrganizationInvitationRepository(
      client(
        rows({ activeMembership: false, supersededOpenInvitation: true }),
        recorded,
      ),
    ).createInvitation(input());

    expect(auditWrite(recorded)?.values[3]).toBe('invitation.resent');
  });
});
