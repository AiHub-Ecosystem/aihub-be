import type { OperationId } from '@/catalog/operation-id';
import type { IdempotencyServicePort } from '@/modules/idempotency/application/idempotency-service.port';
import type { CompletedIdempotencyReplay } from '@/modules/idempotency/public/idempotency-operation';

const WRITING_REPLAY_OPERATIONS = new Set<OperationId>([
  'writing.task1.grade',
  'writing.task2.grade',
  'writing.v2.task1.grade',
  'writing.v2.task2.grade',
  'writing.v2.micro-exercises.create',
  'writing.v2.long-writing-exercises.create',
  'writing.v2.micro-exercises.grade',
]);

export interface CompletedWritingReplayAttempt {
  readonly organizationId: string;
  readonly operation: OperationId;
  readonly idempotencyKey: string | undefined;
  readonly actorId: string;
  readonly requestBody: unknown;
}

/** A confirmed completed replay bypasses exhausted quota without another dispatch or charge. */
export async function findCompletedWritingReplay(
  idempotency: IdempotencyServicePort | undefined,
  attempt: CompletedWritingReplayAttempt,
): Promise<CompletedIdempotencyReplay | undefined> {
  const { organizationId, operation, idempotencyKey, actorId, requestBody } =
    attempt;
  if (
    idempotency?.findCompletedReplay === undefined ||
    idempotencyKey === undefined ||
    !WRITING_REPLAY_OPERATIONS.has(operation)
  ) {
    return undefined;
  }

  try {
    return await idempotency.findCompletedReplay({
      organizationId,
      operation,
      actorId,
      idempotencyKey,
      requestBody,
    });
  } catch {
    return undefined;
  }
}
