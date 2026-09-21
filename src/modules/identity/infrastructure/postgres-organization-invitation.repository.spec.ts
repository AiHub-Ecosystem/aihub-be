import { AppError } from '../../../common/errors/app-error';
import { createRequestContext } from '../../../common/request-context/request-context.factory';
import type { CreateOrganizationInvitationInput } from '../application/organization-invitation.port';

import type {
  PostgresIdentityQueryClient,
  PostgresIdentityTransactionalClient,
} from './postgres-identity.client';
import { PostgresOrganizationInvitationRepository } from './postgres-organization-invitation.repository';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
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

function rows(options: { readonly activeMembership: boolean }) {
  return (text: string): readonly unknown[] => {
    if (text.includes('FROM organizations')) {
      return [{ id: ORGANIZATION_ID, name: 'Acme' }];
    }
    if (text.includes('FROM organization_members')) {
      return options.activeMembership ? [{ '?column?': 1 }] : [];
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
    invitationId: 'oiv_01J00000000000000000000000',
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

describe('PostgresOrganizationInvitationRepository', () => {
  it('supersedes the previous open invitation and inserts the replacement in one transaction', async () => {
    const recorded: RecordedQuery[] = [];
    const repository = new PostgresOrganizationInvitationRepository(
      client(rows({ activeMembership: false }), recorded),
    );

    const result = await repository.createInvitation(input());

    expect(result).toEqual({ kind: 'created', organizationName: 'Acme' });

    const statements = recorded.map(({ text }) => text.trim().split(/\s+/)[0]);
    expect(statements).toEqual(['SELECT', 'SELECT', 'UPDATE', 'INSERT']);

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
      'oiv_01J00000000000000000000000',
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
