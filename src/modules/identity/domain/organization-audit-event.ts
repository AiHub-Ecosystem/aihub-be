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
  | 'organization.renamed'
  | 'organization.suspended'
  | 'organization.restored'
  | 'organization.identity_config_set'
  | 'organization.entitlement_granted'
  | 'invitation.sent'
  | 'invitation.resent'
  | 'invitation.accepted'
  | 'invitation.revoked'
  | 'membership.role_changed'
  | 'membership.disabled'
  | 'membership.owner_transferred'
  | 'membership.owner_attached'
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

/**
 * A rename is labelled by the name it produced; the name it replaced travels
 * in `detail` and is removed with the label by Audit redaction (ADR-0043). A
 * refusal is labelled by the name the Organization kept, and the requested
 * name is left out: it is free text from a caller without authority.
 */
type OrganizationRenamedDraft =
  | {
      readonly action: 'organization.renamed';
      readonly organizationId: string;
      readonly name: string;
      readonly previousName: string;
      readonly denial?: undefined;
    }
  | {
      readonly action: 'organization.renamed';
      readonly organizationId: string;
      readonly name: string;
      readonly denial: OrganizationAuditDenial;
    };

/**
 * An operator act (ADR-0044). No reason travels with it: tenant owners read
 * `detail`, and redaction cannot reach it.
 */
interface OrganizationStatusDraft {
  readonly action: 'organization.suspended' | 'organization.restored';
  readonly organizationId: string;
  /** The current name, removable by Audit redaction. */
  readonly name: string;
}

interface OrganizationIdentityConfigSetDraft {
  readonly action: 'organization.identity_config_set';
  readonly organizationId: string;
  readonly issuer: string;
  readonly sourceKind: 'url' | 'inline';
}

interface OrganizationEntitlementGrantedDraft {
  readonly action: 'organization.entitlement_granted';
  readonly organizationId: string;
  readonly name: string;
  readonly entitlement: string;
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

/**
 * First Owner Attachment, an operator act (ADR-0045). The owner's membership is
 * the target and the operator the actor; `detail` carries the role, as an
 * accepted invitation's does.
 */
interface OwnerAttachedDraft {
  readonly action: 'membership.owner_attached';
  readonly targetUserAccountId: string;
  readonly username: string;
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
  | OrganizationRenamedDraft
  | OrganizationStatusDraft
  | OrganizationIdentityConfigSetDraft
  | OrganizationEntitlementGrantedDraft
  | InvitationDraft
  | InvitationRevokedDraft
  | RoleChangedDraft
  | DisabledDraft
  | OwnerTransferredDraft
  | OwnerAttachedDraft
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
    case 'organization.suspended':
    case 'organization.restored':
      return {
        targetType: 'organization',
        targetId: draft.organizationId,
        targetLabel: draft.name,
        detail: {},
        outcome: 'applied',
      };
    case 'organization.identity_config_set':
      return {
        targetType: 'organization',
        targetId: draft.organizationId,
        targetLabel: 'Identity configuration',
        detail: { issuer: draft.issuer, sourceKind: draft.sourceKind },
        outcome: 'applied',
      };
    case 'organization.entitlement_granted':
      return {
        targetType: 'organization',
        targetId: draft.organizationId,
        targetLabel: draft.name,
        detail: { entitlement: draft.entitlement },
        outcome: 'applied',
      };
    case 'organization.renamed':
      return {
        targetType: 'organization',
        targetId: draft.organizationId,
        targetLabel: draft.name,
        detail:
          draft.denial === undefined
            ? { previousName: draft.previousName }
            : { denial: draft.denial },
        outcome: draft.denial === undefined ? 'applied' : 'denied',
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
    case 'membership.owner_attached':
      return {
        targetType: 'membership',
        targetId: draft.targetUserAccountId,
        targetLabel: draft.username,
        detail: { role: 'owner' },
        outcome: 'applied',
      };
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
