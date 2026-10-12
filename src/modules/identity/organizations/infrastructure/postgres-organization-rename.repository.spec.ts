import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { RenameOrganizationRecordInput } from '@/modules/identity/organizations/application/organization-rename-record.port';

import type { PrismaClient } from '@prisma-client/client';
import { PostgresOrganizationRenameRepository } from './postgres-organization-rename.repository';

const USER_ID = 'usr_01J00000000000000000000001';
const ORGANIZATION_ID = 'org_acme';

interface RecordedQuery {
  readonly values: readonly unknown[];
}

interface ScriptedPostgres {
  readonly writes: RecordedQuery[];
  readonly deniedWrites: RecordedQuery[];
  readonly renames: { readonly id: string; readonly name: string }[];
}

/**
 * Answers the two locking reads in order and records every write, so the
 * authority policy runs in the fast lane. The database lane proves the locks
 * and the trigger; this proves the decisions taken under them.
 *
 * A statement on the client itself is outside the transaction, which is where a
 * refusal is recorded. Inside it, the reads are the two locks, a rename goes
 * through the model delegate, and any other statement is an audit write.
 */
function scriptedClient(
  organization: Record<string, unknown> | undefined,
  membership: Record<string, unknown> | undefined,
): PrismaClient & ScriptedPostgres {
  const recorder: ScriptedPostgres = {
    writes: [],
    deniedWrites: [],
    renames: [],
  };

  const client = {
    ...recorder,
    $queryRawUnsafe: async (_text: string, ...values: unknown[]) => {
      recorder.deniedWrites.push({ values });
      return [];
    },
    $executeRawUnsafe: async (_text: string, ...values: unknown[]) => {
      recorder.deniedWrites.push({ values });
      return 1;
    },
    $transaction: async <T>(
      callback: (transaction: unknown) => Promise<T>,
    ): Promise<T> => {
      let read = 0;
      return callback({
        $queryRawUnsafe: async (_text: string, ...values: unknown[]) => {
          if (read === 0) {
            read += 1;
            return organization === undefined ? [] : [organization];
          }
          if (read === 1) {
            read += 1;
            return membership === undefined ? [] : [membership];
          }
          recorder.writes.push({ values });
          return [];
        },
        $executeRawUnsafe: async (_text: string, ...values: unknown[]) => {
          recorder.writes.push({ values });
          return 1;
        },
        organization: {
          update: async (args: {
            where: { id: string };
            data: { name: string };
          }) => {
            recorder.renames.push({ id: args.where.id, name: args.data.name });
            return {};
          },
        },
      });
    },
  };

  return client as unknown as PrismaClient & ScriptedPostgres;
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
): PrismaClient & ScriptedPostgres {
  return scriptedClient(
    { id: ORGANIZATION_ID, name: 'Acme', status: organizationStatus },
    membership,
  );
}

function auditValues(
  writes: ReadonlyArray<RecordedQuery>,
): readonly unknown[][] {
  return writes
    .filter((write) => write.values[3] === 'organization.renamed')
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

    expect(db.renames).toEqual([
      { id: ORGANIZATION_ID, name: 'Acme Learning' },
    ]);
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
    const db = scriptedClient(undefined, undefined);

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
