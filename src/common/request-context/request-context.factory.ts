import type { RequestContext, UserIdentityMode } from './request-context';

// At least the largest operation timeout (Writing /v2 grading, 125 s, ADR-0143);
// request-context.factory.spec.ts fails when a catalog timeout outgrows it.
export const MAX_DEADLINE_MS = 125_000;

export interface RequestContextInput {
  readonly requestId: string;
  readonly receivedAt: Date;
  readonly deadlineMs: number;
  readonly organizationId?: string;
  readonly apiKeyId?: string;
  readonly environment?: string;
  readonly userId?: string;
  readonly identityMode?: UserIdentityMode;
  readonly scopes: readonly string[];
  readonly signal?: AbortSignal;
}

export function createRequestContext(
  input: RequestContextInput,
): RequestContext {
  if (input.requestId.trim().length === 0) {
    throw new Error('requestId must not be empty');
  }

  if (
    !Number.isInteger(input.deadlineMs) ||
    input.deadlineMs <= 0 ||
    input.deadlineMs > MAX_DEADLINE_MS
  ) {
    throw new Error(
      `deadlineMs must be an integer between 1 and ${MAX_DEADLINE_MS}`,
    );
  }

  const receivedAt = new Date(input.receivedAt.getTime());
  const deadlineAt = new Date(receivedAt.getTime() + input.deadlineMs);
  const signal = input.signal ?? AbortSignal.timeout(input.deadlineMs);
  const base = {
    requestId: input.requestId,
    receivedAt,
    deadlineAt,
    operationTimeoutMs: input.deadlineMs,
    scopes: [...input.scopes],
    signal,
  };

  return {
    ...base,
    ...(input.organizationId === undefined
      ? {}
      : { organizationId: input.organizationId }),
    ...(input.apiKeyId === undefined ? {} : { apiKeyId: input.apiKeyId }),
    ...(input.environment === undefined
      ? {}
      : { environment: input.environment }),
    ...(input.userId === undefined ? {} : { userId: input.userId }),
    ...(input.identityMode === undefined
      ? {}
      : { identityMode: input.identityMode }),
  };
}
