export interface AttachFirstOwnerInput {
  readonly organizationId: string;
  /** The account to make owner, named by exact username. */
  readonly ownerUsername: string;
  /** The operator's own AIHUB User Account, named by exact username. */
  readonly actorUsername: string;
  readonly requestId: string;
  readonly occurredAt: Date;
}

/**
 * Every refusal writes nothing and is its own outcome, so the operator is told
 * which of their inputs was wrong (ADR-0045).
 */
export type AttachFirstOwnerResult = {
  readonly kind:
    | 'attached'
    | 'unchanged'
    | 'organization_not_found'
    | 'owner_invalid'
    | 'actor_invalid'
    | 'actor_is_owner'
    | 'organization_has_members';
};

export interface OrganizationFirstOwnerPort {
  /**
   * Makes the account the first active `owner` of an Organization with no
   * active member and records `membership.owner_attached`, in one durable act.
   */
  attachFirstOwner(
    input: AttachFirstOwnerInput,
  ): Promise<AttachFirstOwnerResult>;
  close(): Promise<void>;
}
