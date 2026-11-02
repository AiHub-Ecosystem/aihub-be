import type { Prisma } from '@prisma-client/client';
import {
  INSERT_ORGANIZATION_AUDIT_EVENT_SQL,
  auditStamp,
  organizationAuditEventId,
  recordOrganizationAuditEvent,
} from './organization-audit-event.store';

describe('organizationAuditEventId', () => {
  it('prefixes a ULID', () => {
    const id = organizationAuditEventId(new Date('2026-09-21T12:00:00.000Z'));

    expect(id).toMatch(/^oae_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sorts by the instant it was stamped with', () => {
    const earlier = organizationAuditEventId(
      new Date('2026-09-21T12:00:00.000Z'),
    );
    const later = organizationAuditEventId(
      new Date('2026-09-21T12:00:01.000Z'),
    );

    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it('keeps mint order within this process for events that share an instant', () => {
    const occurredAt = new Date('2026-09-21T12:00:00.000Z');

    const ids = Array.from({ length: 20 }, () =>
      organizationAuditEventId(occurredAt),
    );

    expect([...ids].sort()).toEqual(ids);
  });
});

describe('recordOrganizationAuditEvent', () => {
  it('persists the declared source beside the linked actor account', async () => {
    const execute = jest.fn().mockResolvedValue(1);
    const client = {
      $executeRawUnsafe: execute,
    } as unknown as Prisma.TransactionClient;
    const occurredAt = new Date('2026-10-19T12:00:00.000Z');
    const stamp = auditStamp(
      {
        context: { requestId: 'req_01J00000000000000000000000' },
        organizationId: 'org_acme',
      },
      'usr_operator',
      occurredAt,
      'self_declared_operator',
    );

    await recordOrganizationAuditEvent(client, stamp, {
      action: 'api_key.revoked',
      apiKeyId: 'key_demo',
      name: 'Production key',
      keyPrefix: 'aihub_sk_A1b2C3',
    });

    expect(execute).toHaveBeenCalledWith(
      INSERT_ORGANIZATION_AUDIT_EVENT_SQL,
      expect.any(String),
      'org_acme',
      'usr_operator',
      'self_declared_operator',
      'api_key.revoked',
      'applied',
      'api_key',
      'key_demo',
      'Production key',
      JSON.stringify({ keyPrefix: 'aihub_sk_A1b2C3' }),
      'req_01J00000000000000000000000',
      occurredAt,
    );
  });
});
