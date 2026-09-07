export interface RequestContext {
  readonly requestId: string;
  readonly receivedAt: Date;
  readonly deadlineAt: Date;
  readonly organizationId?: string;
  readonly apiKeyId?: string;
  readonly userId?: string;
  readonly scopes: readonly string[];
  readonly signal: AbortSignal;
}
