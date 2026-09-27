export interface RequestContext {
  readonly requestId: string;
  readonly receivedAt: Date;
  readonly deadlineAt: Date;
  readonly organizationId?: string;
  readonly apiKeyId?: string;
  readonly environment?: string;
  readonly sandboxOrganizationDispatchLimit?: number | null;
  readonly userId?: string;
  readonly scopes: readonly string[];
  readonly signal: AbortSignal;
}
