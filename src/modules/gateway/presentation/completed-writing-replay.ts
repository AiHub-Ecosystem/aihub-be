import type { OperationId } from '@/catalog/operation-id';
import { parseRequestBody } from '@/common/http/parse-request-body';
import {
  GradeTask1RequestSchema,
  GradeTask2RequestSchema,
} from '@/contracts/writing/grading';
import type { IdempotencyServicePort } from '@/modules/idempotency/application/idempotency-service.port';
import type {
  AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { setCompletedReplay } from './completed-idempotency-replay';

/**
 * Whether this request repeats a Writing grading AIHUB already completed with
 * the same key and the same body. A confirmed replay costs no quota, so it may
 * pass an exhausted quota; the stored result is then handed to the executor
 * through the request. Anything short of a durable match answers `false`.
 */
export async function confirmCompletedWritingReplay(
  request: AuthenticatedRequest,
  authenticated: ReturnType<typeof getAuthenticatedApiKey>,
  idempotency: IdempotencyServicePort | undefined,
  operation: OperationId,
  idempotencyKey: string | undefined,
): Promise<boolean> {
  const actorId = request.aihubIdentity?.userId;
  if (
    idempotency?.findCompletedReplay === undefined ||
    actorId === undefined ||
    idempotencyKey === undefined ||
    (operation !== 'writing.task1.grade' && operation !== 'writing.task2.grade')
  ) {
    return false;
  }

  let requestBody: unknown;
  try {
    requestBody =
      operation === 'writing.task1.grade'
        ? parseRequestBody(GradeTask1RequestSchema, request.body, request)
        : parseRequestBody(GradeTask2RequestSchema, request.body, request);
  } catch {
    return false;
  }

  try {
    const replay = await idempotency.findCompletedReplay({
      organizationId: authenticated.organizationId,
      operation,
      actorId,
      idempotencyKey,
      requestBody,
    });
    if (replay === undefined) return false;
    setCompletedReplay(request, { operation, idempotencyKey, replay });
    return true;
  } catch {
    // A replay bypass at an exhausted quota needs a confirmed durable match.
    return false;
  }
}
