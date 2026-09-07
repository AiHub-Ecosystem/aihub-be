import type { RequestContext } from './request-context';

const MAX_DEADLINE_MS = 120_000;

export interface RequestContextInput {
  readonly requestId: string;
  readonly receivedAt: Date;
  readonly deadlineMs: number;
  readonly organizationId?: string;
  readonly apiKeyId?: string;
  readonly userId?: string;
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
    scopes: [...input.scopes],
    signal,
  };

  return {
    ...base,
    ...(input.organizationId === undefined
      ? {}
      : { organizationId: input.organizationId }),
    ...(input.apiKeyId === undefined ? {} : { apiKeyId: input.apiKeyId }),
    ...(input.userId === undefined ? {} : { userId: input.userId }),
  };
}
