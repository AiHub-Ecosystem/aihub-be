import type { Pool } from 'pg';
import { ulid } from 'ulid';

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
    await expect(insertEvent({ targetType: 'organization' })).rejects.toThrow(
      /check constraint/,
    );
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
