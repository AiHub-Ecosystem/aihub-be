import type { OperationId } from '@/catalog/operation-id';
import { parseRequestBody } from '@/common/http/parse-request-body';
import {
  GradeTask1RequestSchema,
  GradeTask2RequestSchema,
} from '@/contracts/writing/grading';
import {
  CreateLongWritingExerciseRequestSchema,
  CreateMicroExerciseRequestSchema,
  GradeMicroExerciseRequestSchema,
} from '@/contracts/writing/v2/exercises';
import {
  WritingV2GradeTask1RequestSchema,
  WritingV2GradeTask2RequestSchema,
} from '@/contracts/writing/v2/grading';
import type { IdempotencyServicePort } from '@/modules/idempotency/application/idempotency-service.port';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import type { CompletedReplayForRequest } from './completed-idempotency-replay';

/** The idempotent Writing operations a completed replay can be confirmed for. */
const WRITING_REPLAY_SCHEMAS = {
  'writing.task1.grade': GradeTask1RequestSchema,
  'writing.task2.grade': GradeTask2RequestSchema,
  'writing.v2.task1.grade': WritingV2GradeTask1RequestSchema,
  'writing.v2.task2.grade': WritingV2GradeTask2RequestSchema,
  'writing.v2.micro-exercises.create': CreateMicroExerciseRequestSchema,
  'writing.v2.long-writing-exercises.create':
    CreateLongWritingExerciseRequestSchema,
  'writing.v2.micro-exercises.grade': GradeMicroExerciseRequestSchema,
} as const;

function isWritingReplayOperation(
  operation: OperationId,
): operation is keyof typeof WRITING_REPLAY_SCHEMAS {
  return Object.hasOwn(WRITING_REPLAY_SCHEMAS, operation);
}

export interface CompletedWritingReplayAttempt {
  readonly organizationId: string;
  readonly operation: OperationId;
  readonly idempotencyKey: string | undefined;
}

/**
 * The stored result of a Writing grading AIHUB already completed with the same
 * key and the same body, or `undefined`. A confirmed replay costs no quota, so
 * the caller may let it pass an exhausted quota; anything short of a durable
 * match answers `undefined`.
 */
export async function findCompletedWritingReplay(
  request: AuthenticatedRequest,
  idempotency: IdempotencyServicePort | undefined,
  attempt: CompletedWritingReplayAttempt,
): Promise<CompletedReplayForRequest | undefined> {
  const { organizationId, operation, idempotencyKey } = attempt;
  const actorId = request.aihubIdentity?.userId;
  if (
    idempotency?.findCompletedReplay === undefined ||
    actorId === undefined ||
    idempotencyKey === undefined ||
    !isWritingReplayOperation(operation)
  ) {
    return undefined;
  }

  let requestBody: unknown;
  try {
    requestBody = parseRequestBody(
      WRITING_REPLAY_SCHEMAS[operation],
      request.body,
      request,
    );
  } catch {
    return undefined;
  }

  try {
    const replay = await idempotency.findCompletedReplay({
      organizationId,
      operation,
      actorId,
      idempotencyKey,
      requestBody,
    });
    return replay === undefined
      ? undefined
      : { operation, idempotencyKey, replay };
  } catch {
    // A replay bypass at an exhausted quota needs a confirmed durable match.
    return undefined;
  }
}
