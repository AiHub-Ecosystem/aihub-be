/**
 * Organization Audit Events: the durable, append-only record of organization
 * control-plane acts. ADR-0035 records the boundary.
 *
 * The draft union below is the `detail` whitelist made structural. Nothing
 * reaches an event except through one of these variants, so the ordinary way a
 * credential leaks into a table nobody can edit — serialising an input object —
 * has no expression here.
 */

export type OrganizationAuditAction =
  | 'organization.created'
  | 'invitation.sent'
  | 'invitation.resent'
  | 'invitation.accepted'
  | 'invitation.revoked'
  | 'membership.role_changed'
  | 'membership.disabled'
  | 'membership.owner_transferred'
  | 'api_key.created'
  | 'api_key.rotated'
  | 'api_key.revoked';

export type OrganizationAuditOutcome = 'applied' | 'denied';

export type OrganizationAuditTargetType =
  | 'organization'
  | 'membership'
  | 'invitation'
  | 'api_key';

/**
 * Restated here rather than imported: domain code depends on itself, and the
 * application's membership role type belongs to a layer this one cannot see.
 */
export type OrganizationAuditRole = 'owner' | 'admin' | 'member';

/**
 * Why a recorded attempt was refused. Only refusals against a real target are
 * recorded, so both values name a decision about a target that exists.
 */
export type OrganizationAuditDenial =
  | 'insufficient_authority'
  | 'owner_required';

/** Everything an event carries that does not depend on which act it records. */
export interface OrganizationAuditStamp {
  readonly id: string;
  readonly organizationId: string;
  readonly actorUserAccountId: string;
  readonly requestId: string;
  readonly occurredAt: Date;
}

export interface OrganizationAuditEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly actorUserAccountId: string;
  readonly action: OrganizationAuditAction;
  readonly outcome: OrganizationAuditOutcome;
  readonly targetType: OrganizationAuditTargetType;
  readonly targetId: string;
  readonly targetLabel: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly requestId: string;
  readonly occurredAt: Date;
}

interface OrganizationCreatedDraft {
  readonly action: 'organization.created';
  readonly organizationId: string;
  /** The name as created, removable by Audit redaction. */
  readonly name: string;
}

interface InvitationDraft {
  readonly action:
    | 'invitation.sent'
    | 'invitation.resent'
    | 'invitation.accepted';
  readonly invitationId: string;
  /** The normalized email, kept plaintext and removable by Audit redaction. */
  readonly email: string;
  readonly role: OrganizationAuditRole;
}

interface InvitationRevokedDraft {
  readonly action: 'invitation.revoked';
  readonly invitationId: string;
  /** The normalized email, kept plaintext and removable by Audit redaction. */
  readonly email: string;
  readonly role: OrganizationAuditRole;
  readonly denial?: OrganizationAuditDenial;
}

interface RoleChangedDraft {
  readonly action: 'membership.role_changed';
  readonly targetUserAccountId: string;
  readonly username: string;
  readonly fromRole: OrganizationAuditRole;
  readonly toRole: OrganizationAuditRole;
  readonly denial?: OrganizationAuditDenial;
}

interface DisabledDraft {
  readonly action: 'membership.disabled';
  readonly targetUserAccountId: string;
  readonly username: string;
  readonly role: OrganizationAuditRole;
  readonly denial?: OrganizationAuditDenial;
}

interface OwnerTransferredDraft {
  readonly action: 'membership.owner_transferred';
  readonly targetUserAccountId: string;
  readonly username: string;
  readonly fromRole: OrganizationAuditRole;
  /** The outgoing owner, who becomes an admin in the same durable act. */
  readonly previousOwnerUsername: string;
  readonly denial?: OrganizationAuditDenial;
}

interface ApiKeyCreatedDraft {
  readonly action: 'api_key.created';
  readonly apiKeyId: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly string[];
  readonly allowedEnvironments: readonly string[];
}

interface ApiKeyRotatedDraft {
  readonly action: 'api_key.rotated';
  /** The key withdrawn by the rotation; the replacement is named in `detail`. */
  readonly apiKeyId: string;
  readonly name: string;
  /** The withdrawn key's own prefix: it is this event's target, not the replacement. */
  readonly keyPrefix: string;
  readonly replacementId: string;
  readonly replacementKeyPrefix: string;
  readonly scopes: readonly string[];
  readonly allowedEnvironments: readonly string[];
}

interface ApiKeyRevokedDraft {
  readonly action: 'api_key.revoked';
  readonly apiKeyId: string;
  readonly name: string;
  readonly keyPrefix: string;
}

export type OrganizationAuditDraft =
  | OrganizationCreatedDraft
  | InvitationDraft
  | InvitationRevokedDraft
  | RoleChangedDraft
  | DisabledDraft
  | OwnerTransferredDraft
  | ApiKeyCreatedDraft
  | ApiKeyRotatedDraft
  | ApiKeyRevokedDraft;

interface Shape {
  readonly targetType: OrganizationAuditTargetType;
  readonly targetId: string;
  readonly targetLabel: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly outcome: OrganizationAuditOutcome;
}

function refusal(draft: {
  readonly denial?: OrganizationAuditDenial;
}): Pick<Shape, 'outcome'> & { readonly denial?: OrganizationAuditDenial } {
  return draft.denial === undefined
    ? { outcome: 'applied' }
    : { outcome: 'denied', denial: draft.denial };
}

function shape(draft: OrganizationAuditDraft): Shape {
  switch (draft.action) {
    // Commercial terms stay out of `detail`: they are an operator's to state,
    // and the Organization row already holds them.
    case 'organization.created':
      return {
        targetType: 'organization',
        targetId: draft.organizationId,
        targetLabel: draft.name,
        detail: {},
        outcome: 'applied',
      };
    case 'invitation.sent':
    case 'invitation.resent':
    case 'invitation.accepted':
      return {
        targetType: 'invitation',
        targetId: draft.invitationId,
        targetLabel: draft.email,
        detail: { role: draft.role },
        outcome: 'applied',
      };
    case 'invitation.revoked': {
      const { outcome, denial } = refusal(draft);
      return {
        targetType: 'invitation',
        targetId: draft.invitationId,
        targetLabel: draft.email,
        detail:
          denial === undefined
            ? { role: draft.role }
            : { role: draft.role, denial },
        outcome,
      };
    }
    // A refused attempt carries what was asked for, never a transition: an
    // event that says `toRole` describes a change that did not happen.
    case 'membership.role_changed': {
      const { outcome, denial } = refusal(draft);
      return {
        targetType: 'membership',
        targetId: draft.targetUserAccountId,
        targetLabel: draft.username,
        detail:
          denial === undefined
            ? { fromRole: draft.fromRole, toRole: draft.toRole }
            : {
                fromRole: draft.fromRole,
                requestedRole: draft.toRole,
                denial,
              },
        outcome,
      };
    }
    case 'membership.disabled': {
      const { outcome, denial } = refusal(draft);
      return {
        targetType: 'membership',
        targetId: draft.targetUserAccountId,
        targetLabel: draft.username,
        detail:
          denial === undefined
            ? { role: draft.role, fromStatus: 'active', toStatus: 'disabled' }
            : { role: draft.role, denial },
        outcome,
      };
    }
    case 'membership.owner_transferred': {
      const { outcome, denial } = refusal(draft);
      return {
        targetType: 'membership',
        targetId: draft.targetUserAccountId,
        targetLabel: draft.username,
        detail:
          denial === undefined
            ? {
                fromRole: draft.fromRole,
                toRole: 'owner',
                previousOwnerUsername: draft.previousOwnerUsername,
                previousOwnerRole: 'admin',
              }
            : {
                fromRole: draft.fromRole,
                previousOwnerUsername: draft.previousOwnerUsername,
                denial,
              },
        outcome,
      };
    }
    case 'api_key.created':
      return {
        targetType: 'api_key',
        targetId: draft.apiKeyId,
        targetLabel: draft.name,
        detail: {
          keyPrefix: draft.keyPrefix,
          scopes: [...draft.scopes],
          allowedEnvironments: [...draft.allowedEnvironments],
        },
        outcome: 'applied',
      };
    case 'api_key.rotated':
      return {
        targetType: 'api_key',
        targetId: draft.apiKeyId,
        targetLabel: draft.name,
        detail: {
          keyPrefix: draft.keyPrefix,
          replacementId: draft.replacementId,
          replacementKeyPrefix: draft.replacementKeyPrefix,
          scopes: [...draft.scopes],
          allowedEnvironments: [...draft.allowedEnvironments],
        },
        outcome: 'applied',
      };
    case 'api_key.revoked':
      return {
        targetType: 'api_key',
        targetId: draft.apiKeyId,
        targetLabel: draft.name,
        detail: { keyPrefix: draft.keyPrefix },
        outcome: 'applied',
      };
  }
}

export function organizationAuditEvent(
  stamp: OrganizationAuditStamp,
  draft: OrganizationAuditDraft,
): OrganizationAuditEvent {
  const mapped = shape(draft);

  return {
    id: stamp.id,
    organizationId: stamp.organizationId,
    actorUserAccountId: stamp.actorUserAccountId,
    action: draft.action,
    outcome: mapped.outcome,
    targetType: mapped.targetType,
    targetId: mapped.targetId,
    targetLabel: mapped.targetLabel,
    detail: mapped.detail,
    requestId: stamp.requestId,
    occurredAt: new Date(stamp.occurredAt.getTime()),
  };
}
