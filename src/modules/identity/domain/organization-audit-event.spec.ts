import {
  type OrganizationAuditDraft,
  type OrganizationAuditStamp,
  organizationAuditEvent,
} from './organization-audit-event';

const STAMP: OrganizationAuditStamp = {
  id: 'oae_01J00000000000000000000000',
  organizationId: 'org_acme',
  actorUserAccountId: 'usr_01J00000000000000000000001',
  requestId: 'req_01J00000000000000000000002',
  occurredAt: new Date('2026-09-21T10:00:00.000Z'),
};

describe('organizationAuditEvent', () => {
  it('records an invitation against the invitation, labelled by the invited email', () => {
    const event = organizationAuditEvent(STAMP, {
      action: 'invitation.sent',
      invitationId: 'oiv_01J00000000000000000000003',
      email: 'invitee@example.com',
      role: 'member',
    });

    expect(event).toEqual({
      ...STAMP,
      action: 'invitation.sent',
      outcome: 'applied',
      targetType: 'invitation',
      targetId: 'oiv_01J00000000000000000000003',
      targetLabel: 'invitee@example.com',
      detail: { role: 'member' },
    });
  });

  it('records an applied invitation revocation without token material', () => {
    const event = organizationAuditEvent(STAMP, {
      action: 'invitation.revoked',
      invitationId: 'oiv_01J00000000000000000000003',
      email: 'invitee@example.com',
      role: 'member',
    });

    expect(event).toEqual({
      ...STAMP,
      action: 'invitation.revoked',
      outcome: 'applied',
      targetType: 'invitation',
      targetId: 'oiv_01J00000000000000000000003',
      targetLabel: 'invitee@example.com',
      detail: { role: 'member' },
    });
  });

  it('records an invitation revocation denial against a real target', () => {
    const event = organizationAuditEvent(STAMP, {
      action: 'invitation.revoked',
      invitationId: 'oiv_01J00000000000000000000003',
      email: 'invitee@example.com',
      role: 'admin',
      denial: 'insufficient_authority',
    });

    expect(event.outcome).toBe('denied');
    expect(event.detail).toEqual({
      role: 'admin',
      denial: 'insufficient_authority',
    });
  });

  it('keeps the role a membership held before the change, not only the one it gained', () => {
    const event = organizationAuditEvent(STAMP, {
      action: 'membership.role_changed',
      targetUserAccountId: 'usr_01J00000000000000000000004',
      username: 'bob',
      fromRole: 'member',
      toRole: 'admin',
    });

    expect(event.detail).toEqual({ fromRole: 'member', toRole: 'admin' });
    expect(event.targetType).toBe('membership');
    expect(event.targetId).toBe('usr_01J00000000000000000000004');
    expect(event.targetLabel).toBe('bob');
  });

  it('records one transfer naming both parties rather than two role changes', () => {
    const event = organizationAuditEvent(STAMP, {
      action: 'membership.owner_transferred',
      targetUserAccountId: 'usr_01J00000000000000000000004',
      username: 'bob',
      fromRole: 'admin',
      previousOwnerUsername: 'alice',
    });

    expect(event.action).toBe('membership.owner_transferred');
    expect(event.detail).toEqual({
      fromRole: 'admin',
      toRole: 'owner',
      previousOwnerUsername: 'alice',
      previousOwnerRole: 'admin',
    });
  });

  it('marks a refused attempt as denied and says why', () => {
    const event = organizationAuditEvent(STAMP, {
      action: 'membership.disabled',
      targetUserAccountId: 'usr_01J00000000000000000000004',
      username: 'bob',
      role: 'owner',
      denial: 'owner_required',
    });

    expect(event.outcome).toBe('denied');
    // A refusal never claims a transition: the membership stayed active.
    expect(event.detail).toEqual({ role: 'owner', denial: 'owner_required' });
  });

  it('records what a refused role change asked for, not a change that happened', () => {
    const event = organizationAuditEvent(STAMP, {
      action: 'membership.role_changed',
      targetUserAccountId: 'usr_01J00000000000000000000004',
      username: 'bob',
      fromRole: 'owner',
      toRole: 'member',
      denial: 'insufficient_authority',
    });

    expect(event.detail).toEqual({
      fromRole: 'owner',
      requestedRole: 'member',
      denial: 'insufficient_authority',
    });
  });

  it('treats an attempt with no denial as applied', () => {
    const event = organizationAuditEvent(STAMP, {
      action: 'membership.disabled',
      targetUserAccountId: 'usr_01J00000000000000000000004',
      username: 'bob',
      role: 'member',
    });

    expect(event.outcome).toBe('applied');
    expect(event.detail).toEqual({
      role: 'member',
      fromStatus: 'active',
      toStatus: 'disabled',
    });
  });

  it('names the replacement a rotation installed beside the key it withdrew', () => {
    const event = organizationAuditEvent(STAMP, {
      action: 'api_key.rotated',
      apiKeyId: 'ak_01J00000000000000000000005',
      name: 'Prod backend',
      keyPrefix: 'aihub_sk_Z9y8X7',
      replacementId: 'ak_01J00000000000000000000006',
      replacementKeyPrefix: 'aihub_sk_A1b2C3',
      scopes: ['writing.grade'],
      allowedEnvironments: ['production'],
    });

    expect(event.targetId).toBe('ak_01J00000000000000000000005');
    expect(event.detail).toEqual({
      keyPrefix: 'aihub_sk_Z9y8X7',
      replacementId: 'ak_01J00000000000000000000006',
      replacementKeyPrefix: 'aihub_sk_A1b2C3',
      scopes: ['writing.grade'],
      allowedEnvironments: ['production'],
    });
  });

  it('carries no credential material for any act it can record', () => {
    const drafts: readonly OrganizationAuditDraft[] = [
      {
        action: 'invitation.accepted',
        invitationId: 'oiv_1',
        email: 'invitee@example.com',
        role: 'member',
      },
      {
        action: 'api_key.created',
        apiKeyId: 'ak_1',
        name: 'Prod backend',
        keyPrefix: 'aihub_sk_A1b2C3',
        scopes: ['writing.grade'],
        allowedEnvironments: ['production'],
      },
      {
        action: 'api_key.revoked',
        apiKeyId: 'ak_1',
        name: 'Prod backend',
        keyPrefix: 'aihub_sk_A1b2C3',
      },
    ];

    for (const draft of drafts) {
      const serialized = JSON.stringify(organizationAuditEvent(STAMP, draft));
      for (const forbidden of [
        'keyHash',
        'key_hash',
        'tokenHash',
        'token_hash',
        'password',
        'assertion',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

  it('copies the stamped instant rather than aliasing the caller clock', () => {
    const occurredAt = new Date('2026-09-21T10:00:00.000Z');
    const event = organizationAuditEvent(
      { ...STAMP, occurredAt },
      {
        action: 'api_key.revoked',
        apiKeyId: 'ak_1',
        name: 'Prod backend',
        keyPrefix: 'aihub_sk_A1b2C3',
      },
    );

    occurredAt.setFullYear(1999);

    expect(event.occurredAt.toISOString()).toBe('2026-09-21T10:00:00.000Z');
  });
});
