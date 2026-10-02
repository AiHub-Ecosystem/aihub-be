import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import type {
  ListOrganizationAuditEventsInput,
  OrganizationAuditEventFilter,
  OrganizationAuditEventPosition,
} from '@/modules/identity/application/organization-audit-event-read.port';
import { organizationAuditEventId } from '@/modules/identity/infrastructure/organization-audit-event.store';
import { PostgresOrganizationAuditReadRepository } from '@/modules/identity/infrastructure/postgres-organization-audit-read.repository';

import { createTestPool, resetIdentityTables } from './database';

/**
 * The append-only guarantee is a property of PostgreSQL, not of our code, so
 * it is only provable here. A fast-lane spec asserting the migration file
 * contains `CREATE TRIGGER` is evidence about a string.
 */

const ORGANIZATION_ID = 'org_acme';

let pool: Pool;
let actorId: string;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
  await pool.query(
    'INSERT INTO organizations (id, name, status) VALUES ($1, $2, $3)',
    [ORGANIZATION_ID, 'Acme', 'active'],
  );
  actorId = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', now(), now())`,
    [actorId, `user-${actorId.slice(4, 16).toLowerCase()}`],
  );
});

async function insertEvent(
  overrides: {
    readonly id?: string;
    readonly action?: string;
    readonly outcome?: string;
    readonly targetType?: string;
    readonly targetLabel?: string | null;
  } = {},
): Promise<string> {
  const {
    id = `oae_${ulid()}`,
    action = 'membership.role_changed',
    outcome = 'applied',
    targetType = 'membership',
    targetLabel = 'bob',
  } = overrides;

  await pool.query(
    `INSERT INTO organization_audit_events (
       id, organization_id, actor_user_account_id, action, outcome,
       target_type, target_id, target_label, detail, request_id, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      ORGANIZATION_ID,
      actorId,
      action,
      outcome,
      targetType,
      'usr_target',
      targetLabel,
      JSON.stringify({ fromRole: 'member', toRole: 'admin' }),
      `req_${ulid()}`,
      new Date('2026-09-21T10:00:00.000Z'),
    ],
  );

  return id;
}

describe('organization audit events against PostgreSQL', () => {
  it('refuses to delete a recorded event', async () => {
    const id = await insertEvent();

    await expect(
      pool.query('DELETE FROM organization_audit_events WHERE id = $1', [id]),
    ).rejects.toThrow(/append-only/);

    const remaining = await pool.query(
      'SELECT id FROM organization_audit_events WHERE id = $1',
      [id],
    );
    expect(remaining.rowCount).toBe(1);
  });

  it('refuses to change anything but the target label', async () => {
    const id = await insertEvent();

    for (const [column, value] of [
      ['action', 'membership.disabled'],
      ['outcome', 'denied'],
      ['target_id', 'usr_someone_else'],
      ['request_id', `req_${ulid()}`],
    ] as const) {
      await expect(
        pool.query(
          `UPDATE organization_audit_events SET ${column} = $2 WHERE id = $1`,
          [id, value],
        ),
      ).rejects.toThrow(/only target_label redaction/);
    }
  });

  it('refuses to rewrite the target label to another value', async () => {
    const id = await insertEvent({ targetLabel: 'invitee@example.com' });

    // The one writable column removes a label; it never restates one.
    await expect(
      pool.query(
        'UPDATE organization_audit_events SET target_label = $2 WHERE id = $1',
        [id, 'someone-else@example.com'],
      ),
    ).rejects.toThrow(/only target_label redaction/);
  });

  it('allows redaction to remove the label and leave the event standing', async () => {
    const id = await insertEvent({ targetLabel: 'invitee@example.com' });

    await pool.query(
      'UPDATE organization_audit_events SET target_label = NULL WHERE id = $1',
      [id],
    );

    const row = await pool.query<{
      target_label: string | null;
      action: string;
      actor_user_account_id: string;
    }>(
      `SELECT target_label, action, actor_user_account_id
       FROM organization_audit_events WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]?.target_label).toBeNull();
    expect(row.rows[0]?.action).toBe('membership.role_changed');
    expect(row.rows[0]?.actor_user_account_id).toBe(actorId);
  });

  it('refuses an identifier that does not follow the audit event convention', async () => {
    await expect(insertEvent({ id: `oiv_${ulid()}` })).rejects.toThrow(
      /organization_audit_events_id_check|check constraint/,
    );
  });

  it('refuses an action, outcome, or target type it does not name', async () => {
    await expect(insertEvent({ action: 'api_key.renamed' })).rejects.toThrow(
      /check constraint/,
    );
    await expect(insertEvent({ outcome: 'replayed' })).rejects.toThrow(
      /check constraint/,
    );
    await expect(insertEvent({ targetType: 'user_account' })).rejects.toThrow(
      /check constraint/,
    );
  });

  it('names Organization creation alongside every action and target type it already named', async () => {
    await expect(
      insertEvent({
        action: 'organization.created',
        targetType: 'organization',
      }),
    ).resolves.toMatch(/^oae_/);
    for (const action of [
      'invitation.sent',
      'invitation.resent',
      'invitation.accepted',
      'invitation.revoked',
      'membership.role_changed',
      'membership.disabled',
      'membership.owner_transferred',
      'api_key.created',
      'api_key.rotated',
      'api_key.revoked',
    ]) {
      await expect(insertEvent({ action })).resolves.toMatch(/^oae_/);
    }
    for (const targetType of ['membership', 'invitation', 'api_key']) {
      await expect(insertEvent({ targetType })).resolves.toMatch(/^oae_/);
    }
  });

  it('accepts the invitation revocation action added by its migration', async () => {
    await expect(
      insertEvent({
        action: 'invitation.revoked',
        targetType: 'invitation',
        targetLabel: 'invitee@example.com',
      }),
    ).resolves.toMatch(/^oae_/);
  });

  it('refuses an actor that is not a durable account', async () => {
    await expect(
      pool.query(
        `INSERT INTO organization_audit_events (
           id, organization_id, actor_user_account_id, action, outcome,
           target_type, target_id, request_id, occurred_at
         ) VALUES ($1, $2, $3, 'api_key.revoked', 'applied', 'api_key',
                   'ak_1', 'req_1', now())`,
        [`oae_${ulid()}`, ORGANIZATION_ID, `usr_${ulid()}`],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

/**
 * The read path's ordering and keyset predicate are claims about `ORDER BY`
 * and a row comparison, which only the engine settles. Same reason the
 * append-only trigger is proven here rather than by asserting that a migration
 * file contains a string.
 */
describe('organization audit trail read against PostgreSQL', () => {
  const SECOND_ORGANIZATION_ID = 'org_other';

  function repository(): PostgresOrganizationAuditReadRepository {
    return new PostgresOrganizationAuditReadRepository({
      query: async (text: string, values: readonly unknown[]) => {
        const result = await pool.query(text, [...values]);
        return result.rows;
      },
    });
  }

  function listInput(
    overrides: {
      readonly organizationId?: string;
      readonly after?: OrganizationAuditEventPosition;
      readonly limit?: number;
      readonly filter?: OrganizationAuditEventFilter;
    } = {},
  ): ListOrganizationAuditEventsInput {
    const {
      organizationId = ORGANIZATION_ID,
      after,
      limit = 10,
      filter = {},
    } = overrides;

    return {
      context: createRequestContext({
        requestId: `req_${ulid()}`,
        receivedAt: new Date(),
        deadlineMs: 5_000,
        organizationId,
        userId: actorId,
        scopes: [],
      }),
      organizationId,
      filter,
      ...(after === undefined ? {} : { after }),
      limit,
    };
  }

  async function insertAt(
    occurredAt: Date,
    overrides: {
      readonly organizationId?: string;
      readonly action?: string;
      readonly targetLabel?: string | null;
    } = {},
  ): Promise<string> {
    const {
      organizationId = ORGANIZATION_ID,
      action = 'membership.role_changed',
      targetLabel = 'bob',
    } = overrides;
    const id = organizationAuditEventId(occurredAt);

    await pool.query(
      `INSERT INTO organization_audit_events (
         id, organization_id, actor_user_account_id, action, outcome,
         target_type, target_id, target_label, detail, request_id, occurred_at
       ) VALUES ($1, $2, $3, $4, 'applied', 'membership', 'usr_target',
                 $5, $6, $7, $8)`,
      [
        id,
        organizationId,
        actorId,
        action,
        targetLabel,
        JSON.stringify({ fromRole: 'member', toRole: 'admin' }),
        `req_${ulid()}`,
        occurredAt,
      ],
    );

    return id;
  }

  it('returns events newest first', async () => {
    const oldest = await insertAt(new Date('2026-09-21T10:00:00.000Z'));
    const middle = await insertAt(new Date('2026-09-21T11:00:00.000Z'));
    const newest = await insertAt(new Date('2026-09-21T12:00:00.000Z'));

    const events = await repository().listAuditEvents(listInput());

    expect(events.map((event) => event.id)).toEqual([newest, middle, oldest]);
  });

  /**
   * The ids come from the monotonic factory the write path uses, so an event
   * recorded after another in the same millisecond sorts after it. Descending
   * order therefore puts the later one first, which is what keeps a denial
   * from narrating itself as having preceded the attempt it refused.
   */
  it('orders events sharing one instant by identifier', async () => {
    const instant = new Date('2026-09-21T10:00:00.000Z');
    const first = await insertAt(instant);
    const second = await insertAt(instant);

    const events = await repository().listAuditEvents(listInput());

    expect(second > first).toBe(true);
    expect(events.map((event) => event.id)).toEqual([second, first]);
  });

  it('pages by keyset with no gap and no repeat', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await insertAt(new Date(Date.UTC(2026, 8, 21, 10, 0, index))));
    }
    const newestFirst = [...ids].reverse();

    const store = repository();
    const firstPage = await store.listAuditEvents(listInput({ limit: 2 }));
    const last = firstPage[firstPage.length - 1];
    if (last === undefined) {
      throw new Error('expected a first page');
    }

    const secondPage = await store.listAuditEvents(
      listInput({
        limit: 2,
        after: { occurredAt: last.occurredAt, id: last.id },
      }),
    );

    expect(firstPage.map((event) => event.id)).toEqual(newestFirst.slice(0, 2));
    expect(secondPage.map((event) => event.id)).toEqual(
      newestFirst.slice(2, 4),
    );
  });

  it('returns the same page when the same position is replayed', async () => {
    for (let index = 0; index < 4; index += 1) {
      await insertAt(new Date(Date.UTC(2026, 8, 21, 10, 0, index)));
    }

    const store = repository();
    const firstPage = await store.listAuditEvents(listInput({ limit: 2 }));
    const last = firstPage[firstPage.length - 1];
    if (last === undefined) {
      throw new Error('expected a first page');
    }
    const position = { occurredAt: last.occurredAt, id: last.id };

    const once = await store.listAuditEvents(
      listInput({ limit: 2, after: position }),
    );
    const twice = await store.listAuditEvents(
      listInput({ limit: 2, after: position }),
    );

    expect(twice.map((event) => event.id)).toEqual(
      once.map((event) => event.id),
    );
  });

  it('never reaches the events of another organization', async () => {
    await pool.query(
      'INSERT INTO organizations (id, name, status) VALUES ($1, $2, $3)',
      [SECOND_ORGANIZATION_ID, 'Other', 'active'],
    );
    const mine = await insertAt(new Date('2026-09-21T10:00:00.000Z'));
    await insertAt(new Date('2026-09-21T11:00:00.000Z'), {
      organizationId: SECOND_ORGANIZATION_ID,
    });

    const events = await repository().listAuditEvents(listInput());

    expect(events.map((event) => event.id)).toEqual([mine]);
  });

  it('filters by action and by a half-open window', async () => {
    await insertAt(new Date('2026-09-21T09:00:00.000Z'), {
      action: 'api_key.revoked',
    });
    const inside = await insertAt(new Date('2026-09-21T10:00:00.000Z'), {
      action: 'api_key.revoked',
    });
    await insertAt(new Date('2026-09-21T11:00:00.000Z'), {
      action: 'api_key.revoked',
    });

    const events = await repository().listAuditEvents(
      listInput({
        filter: {
          actions: ['api_key.revoked'],
          from: new Date('2026-09-21T10:00:00.000Z'),
          to: new Date('2026-09-21T11:00:00.000Z'),
        },
      }),
    );

    expect(events.map((event) => event.id)).toEqual([inside]);
  });

  it('resolves the actor username, including for a disabled account', async () => {
    await pool.query(
      `UPDATE user_accounts SET status = 'disabled' WHERE id = $1`,
      [actorId],
    );
    await insertAt(new Date('2026-09-21T10:00:00.000Z'));

    const events = await repository().listAuditEvents(listInput());

    expect(events[0]?.actorUsername).toBe(
      `user-${actorId.slice(4, 16).toLowerCase()}`,
    );
  });

  it('returns a redacted event with its label absent', async () => {
    const id = await insertAt(new Date('2026-09-21T10:00:00.000Z'));
    await pool.query(
      'UPDATE organization_audit_events SET target_label = NULL WHERE id = $1',
      [id],
    );

    const events = await repository().listAuditEvents(listInput());

    expect(events).toHaveLength(1);
    expect(events[0]?.targetLabel).toBeNull();
  });
});
