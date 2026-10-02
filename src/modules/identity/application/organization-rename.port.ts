import type { RequestContext } from '@/common/request-context/request-context';

export interface RenameOrganizationRecordInput {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  /** Already validated and trimmed. */
  readonly name: string;
}

/**
 * Every refusal is one outcome: the boundary answers them identically, and a
 * refusal worth recording has already been recorded by the time it returns.
 */
export type RenameOrganizationRecordResult =
  | {
      readonly kind: 'renamed' | 'unchanged';
      readonly organizationId: string;
      readonly name: string;
    }
  | { readonly kind: 'forbidden' };

export interface OrganizationRenamePort {
  /**
   * Decides the caller's authority under the Organization and membership
   * locks, then renames and records `organization.renamed` in one durable act,
   * or changes nothing when the name is already the one requested.
   */
  renameOrganization(
    input: RenameOrganizationRecordInput,
  ): Promise<RenameOrganizationRecordResult>;
}

export const ORGANIZATION_RENAME = Symbol('ORGANIZATION_RENAME');
