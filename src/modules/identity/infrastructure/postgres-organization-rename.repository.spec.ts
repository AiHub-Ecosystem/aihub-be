import { createRequestContext } from '../../../common/request-context/request-context.factory';
import type { RenameOrganizationRecordInput } from '../application/organization-rename.port';

import type {
  PostgresIdentityQueryClient,
  PostgresIdentityTransactionalClient,
} from './postgres-identity.client';
import { PostgresOrganizationRenameRepository } from './postgres-organization-rename.repository';

const USER_ID = 'usr_01J00000000000000000000001';
const ORGANIZATION_ID = 'org_acme';
const AUDIT_INSERT = 'INSERT INTO organization_audit_events';

/**
 * Answers the two locking reads in order and records every write, so the
 * authority policy runs in the fast lane. The database lane proves the locks
 * and the trigger; this proves the decisions taken under them.
 */
class ScriptedPostgres implements PostgresIdentityTransactionalClient {
  readonly writes: Array<{ text: string; values: readonly unknown[] }> = [];
  readonly deniedWrites: Array<{ text: string; values: readonly unknown[] }> =
    [];

  constructor(
    private readonly organization: Record<string, unknown> | undefined,
    private readonly membership: Record<string, unknown> | undefined,
  ) {}

  async query(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly unknown[]> {
    this.deniedWrites.push({ text, values });
    return [];
  }

  transaction<T>(
    callback: (client: PostgresIdentityQueryClient) => Promise<T>,
  ): Promise<T> {
    const reads = [this.organization, this.membership];
    return callback({
      query: async (text, values) => {
        if (text.includes('FOR UPDATE')) {
          const row = reads.shift();
          return row === undefined ? [] : [row];
        }
        this.writes.push({ text, values });
        return [];
      },
    });
  }
}

function input(name = 'Acme Learning'): RenameOrganizationRecordInput {
  return {
    context: createRequestContext({
      requestId: 'req_01J00000000000000000000000',
      receivedAt: new Date('2026-09-23T00:00:00.000Z'),
      deadlineMs: 5_000,
      userId: USER_ID,
      scopes: [],
    }),
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    name,
  };
}

function scripted(
  membership: { role: string; status: string } | undefined,
  organizationStatus = 'active',
): ScriptedPostgres {
  return new ScriptedPostgres(
    { id: ORGANIZATION_ID, name: 'Acme', status: organizationStatus },
    membership,
  );
}

function auditValues(
  writes: ReadonlyArray<{ text: string; values: readonly unknown[] }>,
): readonly unknown[][] {
  return writes
    .filter((write) => write.text.includes(AUDIT_INSERT))
    .map((write) => [...write.values]);
}

describe('PostgresOrganizationRenameRepository', () => {
  it('renames for an active owner and records the previous name in the same act', async () => {
    const db = scripted({ role: 'owner', status: 'active' });

    await expect(
      new PostgresOrganizationRenameRepository(db).renameOrganization(input()),
    ).resolves.toEqual({
      kind: 'renamed',
      organizationId: ORGANIZATION_ID,
      name: 'Acme Learning',
    });

    const [event] = auditValues(db.writes);
    expect(event).toEqual(
      expect.arrayContaining([
        'organization.renamed',
        'applied',
        'Acme Learning',
        JSON.stringify({ previousName: 'Acme' }),
      ]),
    );
    expect(db.deniedWrites).toEqual([]);
  });

  it('changes nothing when the name is already the one requested', async () => {
    const db = scripted({ role: 'owner', status: 'active' });

    await expect(
      new PostgresOrganizationRenameRepository(db).renameOrganization(
        input('Acme'),
      ),
    ).resolves.toMatchObject({ kind: 'unchanged', name: 'Acme' });
    expect(db.writes).toEqual([]);
  });

  it.each(['admin', 'member'])(
    'refuses an active %s and records the refusal outside the transaction',
    async (role) => {
      const db = scripted({ role, status: 'active' });

      await expect(
        new PostgresOrganizationRenameRepository(db).renameOrganization(
          input('Mine now'),
        ),
      ).resolves.toEqual({ kind: 'forbidden' });

      expect(db.writes).toEqual([]);
      const [event] = auditValues(db.deniedWrites);
      expect(event).toEqual(
        expect.arrayContaining([
          'organization.renamed',
          'denied',
          'Acme',
          JSON.stringify({ denial: 'insufficient_authority' }),
        ]),
      );
      expect(JSON.stringify(event)).not.toContain('Mine now');
    },
  );

  it.each([
    ['a disabled owner', { role: 'owner', status: 'disabled' }, 'active'],
    ['a non-member', undefined, 'active'],
    [
      'the owner of a suspended Organization',
      { role: 'owner', status: 'active' },
      'suspended',
    ],
    [
      'an admin of a suspended Organization',
      { role: 'admin', status: 'active' },
      'suspended',
    ],
  ])(
    'refuses %s without recording anything',
    async (_, membership, organizationStatus) => {
      const db = scripted(membership, organizationStatus);

      await expect(
        new PostgresOrganizationRenameRepository(db).renameOrganization(
          input(),
        ),
      ).resolves.toEqual({ kind: 'forbidden' });
      expect(db.writes).toEqual([]);
      expect(db.deniedWrites).toEqual([]);
    },
  );

  it('refuses an unknown Organization without recording anything', async () => {
    const db = new ScriptedPostgres(undefined, undefined);

    await expect(
      new PostgresOrganizationRenameRepository(db).renameOrganization(input()),
    ).resolves.toEqual({ kind: 'forbidden' });
    expect(db.deniedWrites).toEqual([]);
  });

  it('fails loudly on a membership row outside its vocabulary', async () => {
    const db = scripted({ role: 'superuser', status: 'active' });

    await expect(
      new PostgresOrganizationRenameRepository(db).renameOrganization(input()),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
