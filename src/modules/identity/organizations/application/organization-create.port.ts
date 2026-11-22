export interface CreateOrganizationInput {
  readonly id: string;
  readonly name: string;
  readonly entitlements: readonly string[];
  readonly rateLimitRpm: number;
  readonly maxConcurrent: number;
  readonly monthlyRequestQuota: number | null;
  readonly hardStopOnQuota: boolean;
}

export interface CreateOrganizationResult {
  readonly kind: 'created';
  readonly id: string;
}

export interface OrganizationCreatePort {
  /**
   * Inserts an operator-provisioned Organization.
   * Operator-provisioned organizations start ownerless (ADR-0045) and write no
   * audit event (ADR-0044).
   */
  createOrganization(
    input: CreateOrganizationInput,
  ): Promise<CreateOrganizationResult>;
  close(): Promise<void>;
}
