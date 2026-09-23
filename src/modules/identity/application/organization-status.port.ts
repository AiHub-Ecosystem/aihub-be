import type { OrganizationStatus } from './api-key-authenticator.port';

export interface SetOrganizationStatusInput {
  readonly organizationId: string;
  /** The operator's own AIHUB User Account, named by exact username. */
  readonly actorUsername: string;
  readonly status: OrganizationStatus;
  readonly requestId: string;
  readonly occurredAt: Date;
}

/**
 * Both applied outcomes carry every key the Organization owns, so the caller
 * can purge their identity cache entries. A repeat purges too: rerunning the
 * command is how an operator closes a window a failed purge left open.
 */
export type SetOrganizationStatusResult =
  | {
      readonly kind: 'changed' | 'unchanged';
      readonly keyHashes: readonly string[];
    }
  | { readonly kind: 'organization_not_found' }
  | { readonly kind: 'actor_invalid' };

export interface OrganizationStatusPort {
  /**
   * Sets the status and records `organization.suspended` or
   * `organization.restored` in one durable act, or changes nothing when the
   * status already matches (ADR-0044).
   */
  setOrganizationStatus(
    input: SetOrganizationStatusInput,
  ): Promise<SetOrganizationStatusResult>;
  close(): Promise<void>;
}
