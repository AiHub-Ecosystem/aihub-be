import type { RequestContext } from '@/common/request-context/request-context';

/**
 * The commercial terms a Self-serve Organization starts on. They are never
 * caller-declared; only an operator changes them afterwards (ADR-0041).
 */
export interface SelfServeOrganizationTerms {
  readonly entitlements: readonly string[];
  readonly rateLimitRpm: number;
  readonly maxConcurrent: number;
  readonly monthlyRequestQuota: number;
  readonly hardStopOnQuota: boolean;
}

export interface CreateOrganizationRecordInput {
  readonly context: RequestContext;
  readonly creatorUserId: string;
  readonly name: string;
  readonly terms: SelfServeOrganizationTerms;
  /** The Organization Creation Limit: lifetime creations per account. */
  readonly creationLimit: number;
}

export type CreateOrganizationRecordResult =
  | { readonly kind: 'created'; readonly organizationId: string }
  | { readonly kind: 'limit_reached' }
  | { readonly kind: 'account_inactive' };

export interface OrganizationCreationRecordPort {
  /**
   * Creates the Organization, its creator's active `owner` membership, and the
   * `organization.created` audit event in one durable act, or none of them.
   */
  createOrganization(
    input: CreateOrganizationRecordInput,
  ): Promise<CreateOrganizationRecordResult>;
}

export const ORGANIZATION_CREATION_RECORD = Symbol(
  'ORGANIZATION_CREATION_RECORD',
);
