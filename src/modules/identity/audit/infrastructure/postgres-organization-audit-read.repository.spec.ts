import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { ListOrganizationAuditEventsInput } from '@/modules/identity/audit/application/organization-audit-event-read.port';

import type { PostgresIdentityQueryClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';
import { PostgresOrganizationAuditReadRepository } from './postgres-organization-audit-read.repository';

const ORGANIZATION_ID = 'org_acme';
const USER_ID = 'usr_01J00000000000000000000000';
const TARGET_USER_ID = 'usr_01J0000000000000000000000T';

class FakePostgres implements PostgresIdentityQueryClient {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];
  result: readonly unknown[] = [];
  failure: Error | undefined;

  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]> {
    this.queries.push({ text, values });
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    return Promise.resolve(this.result);
  }
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'oae_01J00000000000000000000001',
    action: 'membership.disabled',
    outcome: 'applied',
    target_type: 'membership',
    target_label: 'grace',
    detail: { role: 'member', fromStatus: 'active', toStatus: 'disabled' },
    actor_username: 'ada',
    request_id: 'req_01J0000000000000000000000X',
    occurred_at: new Date('2026-09-21T08:00:00.000Z'),
    ...overrides,
  };
}

function input(
  overrides: Partial<ListOrganizationAuditEventsInput> = {},
): ListOrganizationAuditEventsInput {
  return {
    context: createRequestContext({
      requestId: 'req_01J00000000000000000000000',
      receivedAt: new Date('2026-09-22T00:00:00.000Z'),
      deadlineMs: 5_000,
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      scopes: [],
    }),
    organizationId: ORGANIZATION_ID,
    filter: {},
    limit: 10,
    ...overrides,
  };
}

describe('PostgresOrganizationAuditReadRepository', () => {
  /**
   * The HTTP seam cannot prove this: it mocks the port, and the record type it
   * mocks structurally cannot hold a durable target identifier. The mapper is
   * the only place a real row — which does carry one, and carries a User
   * Account ID in it for a membership target — is turned into what ships.
   */
  it('never surfaces the durable target identifier, which is a user account id', async () => {
    const client = new FakePostgres();
    client.result = [row({ target_id: TARGET_USER_ID })];

    const events = await new PostgresOrganizationAuditReadRepository(
      client,
    ).listAuditEvents(input());

    expect(JSON.stringify(events)).not.toContain(TARGET_USER_ID);
    expect(JSON.stringify(events)).not.toContain('usr_');
    expect(events[0]).not.toHaveProperty('targetId');
    expect(events[0]).not.toHaveProperty('target_id');
  });

  it('never selects the target identifier or the actor account id at all', async () => {
    const client = new FakePostgres();

    await new PostgresOrganizationAuditReadRepository(client).listAuditEvents(
      input(),
    );

    const sql = client.queries[0]?.text ?? '';
    expect(sql).not.toContain('event.target_id');
    expect(sql).not.toContain('event.actor_user_account_id,');
  });

  /**
   * A trail with a silent hole is worse than an error: a reader cannot tell a
   * dropped event from one that never happened, which is the whole point of
   * the record. The open-invitation listing refuses partial metadata for the
   * same reason.
   */
  it('fails the whole page on a malformed row rather than dropping it', async () => {
    const client = new FakePostgres();
    client.result = [row(), row({ action: 'membership.teleported' })];

    await expect(
      new PostgresOrganizationAuditReadRepository(client).listAuditEvents(
        input(),
      ),
    ).rejects.toThrow('Identity data is invalid');
  });

  it('fails the whole page when the actor projection is unresolvable', async () => {
    const client = new FakePostgres();
    client.result = [row({ actor_username: null })];

    await expect(
      new PostgresOrganizationAuditReadRepository(client).listAuditEvents(
        input(),
      ),
    ).rejects.toThrow('Identity data is invalid');
  });

  it('keeps a redacted label as an absent label rather than a broken row', async () => {
    const client = new FakePostgres();
    client.result = [row({ target_label: null })];

    const events = await new PostgresOrganizationAuditReadRepository(
      client,
    ).listAuditEvents(input());

    expect(events).toHaveLength(1);
    expect(events[0]?.targetLabel).toBeNull();
  });

  it('orders newest first over both columns, so a shared instant still resolves', async () => {
    const client = new FakePostgres();

    await new PostgresOrganizationAuditReadRepository(client).listAuditEvents(
      input(),
    );

    expect(client.queries[0]?.text).toContain(
      'ORDER BY event.occurred_at DESC, event.id DESC',
    );
  });

  it('passes the cursor position as a row comparison on the same pair', async () => {
    const client = new FakePostgres();
    const occurredAt = new Date('2026-09-21T08:00:00.000Z');

    await new PostgresOrganizationAuditReadRepository(client).listAuditEvents(
      input({ after: { occurredAt, id: 'oae_01J00000000000000000000001' } }),
    );

    expect(client.queries[0]?.text).toContain(
      '(event.occurred_at, event.id) < ($2, $3)',
    );
    expect(client.queries[0]?.values[1]).toBe(occurredAt);
    expect(client.queries[0]?.values[2]).toBe('oae_01J00000000000000000000001');
  });

  it('leaves every filter unbound when none was asked for', async () => {
    const client = new FakePostgres();

    await new PostgresOrganizationAuditReadRepository(client).listAuditEvents(
      input(),
    );

    // Positions 2..7 are the cursor pair and the four filters; all null means
    // the query reads the whole trail for this organization.
    expect(client.queries[0]?.values.slice(1, 7)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('refuses an organization the request context does not name', async () => {
    const client = new FakePostgres();

    await expect(
      new PostgresOrganizationAuditReadRepository(client).listAuditEvents(
        input({ organizationId: 'org_other' }),
      ),
    ).rejects.toThrow('Identity organization audit input is invalid');
    expect(client.queries).toHaveLength(0);
  });

  it('reports an unavailable store without leaking the driver error', async () => {
    const client = new FakePostgres();
    client.failure = new Error('connection terminated: password=hunter2');

    await expect(
      new PostgresOrganizationAuditReadRepository(client).listAuditEvents(
        input(),
      ),
    ).rejects.toThrow('Identity store is unavailable');
  });
});
