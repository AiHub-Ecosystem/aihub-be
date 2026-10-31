export type UserIdentityMode = 'declared_id' | 'signed_assertion';

export interface RequestContext {
  readonly requestId: string;
  readonly receivedAt: Date;
  readonly deadlineAt: Date;
  readonly operationTimeoutMs: number;
  readonly organizationId?: string;
  readonly apiKeyId?: string;
  readonly environment?: string;
  readonly userId?: string;
  readonly identityMode?: UserIdentityMode;
  readonly scopes: readonly string[];
  readonly signal: AbortSignal;
}
