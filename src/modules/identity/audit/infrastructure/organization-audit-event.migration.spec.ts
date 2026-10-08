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
        '../../../../../database/migrations/0011_organization_audit_events.sql',
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

  it('extends the action constraint for invitation revocation', async () => {
    const migration = await readFile(
      join(
        __dirname,
        '../../../../../database/migrations/0012_organization_invitation_revocation.sql',
      ),
      'utf8',
    );

    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS organization_audit_events_action_check',
    );
    expect(migration).toContain(
      'ADD CONSTRAINT organization_audit_events_action_check CHECK',
    );
    expect(migration).toContain("'invitation.revoked'");
  });

  it('extends the action constraint and redaction for organization rename', async () => {
    const migration = await readFile(
      join(
        __dirname,
        '../../../../../database/migrations/0015_organization_rename.sql',
      ),
      'utf8',
    );

    expect(migration).toContain(
      'ADD CONSTRAINT organization_audit_events_action_check CHECK',
    );
    expect(migration).toContain("'organization.renamed'");
    // Every shipped action is restated, so the extension cannot drop one.
    expect(migration).toContain("'organization.created'");
    expect(migration).toContain("'api_key.revoked'");
    // The previous name leaves only with the label, and only on a rename.
    expect(migration).toContain("OLD.action = 'organization.renamed'");
    expect(migration).toContain(
      "NEW.detail IS DISTINCT FROM OLD.detail - 'previousName'",
    );
    expect(migration).toContain(
      "RAISE EXCEPTION 'organization_audit_events is append-only'",
    );
  });

  it('extends the action constraint for organization suspension and restoration', async () => {
    const migration = await readFile(
      join(
        __dirname,
        '../../../../../database/migrations/0016_organization_suspension.sql',
      ),
      'utf8',
    );

    expect(migration).toContain(
      'ADD CONSTRAINT organization_audit_events_action_check CHECK',
    );
    for (const action of [
      'organization.created',
      'organization.renamed',
      'organization.suspended',
      'organization.restored',
      'api_key.revoked',
    ]) {
      expect(migration).toContain(`'${action}'`);
    }
  });

  it('extends the action constraint for first owner attachment', async () => {
    const migration = await readFile(
      join(
        __dirname,
        '../../../../../database/migrations/0017_first_owner_attachment.sql',
      ),
      'utf8',
    );

    expect(migration).toContain(
      'ADD CONSTRAINT organization_audit_events_action_check CHECK',
    );
    for (const action of [
      'organization.created',
      'organization.suspended',
      'membership.owner_transferred',
      'membership.owner_attached',
      'api_key.revoked',
    ]) {
      expect(migration).toContain(`'${action}'`);
    }
  });

  it('extends the action constraint for operator entitlement grants', async () => {
    const migration = await readFile(
      join(
        __dirname,
        '../../../../../database/migrations/0021_organization_entitlement_grant.sql',
      ),
      'utf8',
    );
    expect(migration).toContain("'organization.entitlement_granted'");
    expect(migration).toContain("'organization.identity_config_set'");
    expect(migration).toContain("'api_key.revoked'");
  });
});
