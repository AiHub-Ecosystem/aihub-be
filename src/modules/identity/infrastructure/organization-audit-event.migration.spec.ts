import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Holds the schema's intent visible in the fast lane. It asserts about a
 * string, so it is evidence that the migration says what it should, never that
 * PostgreSQL enforces it — `test/db/organization-audit-event.spec.ts` proves
 * the trigger against a real engine.
 */
describe('organization audit event migration', () => {
  it('keeps the durable audit constraints ADR-0035 relies on', async () => {
    const migration = await readFile(
      join(
        __dirname,
        '../../../../database/migrations/0011_organization_audit_events.sql',
      ),
      'utf8',
    );

    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS organization_audit_events',
    );
    expect(migration).toContain("CHECK (id ~ '^oae_[0-9A-HJKMNP-TV-Z]{26}$')");
    expect(migration).toContain(
      'organization_id       text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT',
    );
    expect(migration).toContain(
      'actor_user_account_id text NOT NULL REFERENCES user_accounts(id) ON DELETE RESTRICT',
    );
    expect(migration).toContain("CHECK (outcome IN ('applied', 'denied'))");
    expect(migration).toContain(
      "CHECK (target_type IN ('membership', 'invitation', 'api_key'))",
    );
    expect(migration).toContain('target_id             text NOT NULL');
    expect(migration).toContain('request_id            text NOT NULL');
    expect(migration).toContain('occurred_at           timestamptz NOT NULL');

    // Only shipped mutations are nameable; each new one extends this by
    // migration rather than arriving as free text.
    for (const action of [
      'invitation.sent',
      'invitation.resent',
      'invitation.accepted',
      'membership.role_changed',
      'membership.disabled',
      'membership.owner_transferred',
      'api_key.created',
      'api_key.rotated',
      'api_key.revoked',
    ]) {
      expect(migration).toContain(`'${action}'`);
    }

    // `occurred_at` is the application's instant; a database default would let
    // the engine's clock decide when an act happened.
    expect(migration).not.toContain(
      'occurred_at           timestamptz NOT NULL DEFAULT',
    );

    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON organization_audit_events',
    );
    expect(migration).toContain(
      "RAISE EXCEPTION 'organization_audit_events is append-only'",
    );
    // Redaction removes a label; it never rewrites one.
    expect(migration).toContain('IF NEW.target_label IS NOT NULL THEN');
    expect(migration).toContain('organization_audit_events_org_time_idx');
  });
});
