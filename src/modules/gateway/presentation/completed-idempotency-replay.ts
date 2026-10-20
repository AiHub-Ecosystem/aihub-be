import type {
  CompletedIdempotencyReplay,
  IdempotencyOperation,
} from '@/modules/idempotency/public/idempotency-operation';

export interface CompletedReplayForRequest {
  readonly operation: IdempotencyOperation;
  readonly idempotencyKey: string;
  readonly replay: CompletedIdempotencyReplay;
}

declare module 'fastify' {
  interface FastifyRequest {
    aihubCompletedReplay?: CompletedReplayForRequest;
  }
}

export function setCompletedReplay(
  request: { aihubCompletedReplay?: CompletedReplayForRequest },
  replay: CompletedReplayForRequest,
): void {
  request.aihubCompletedReplay = replay;
}

export function takeCompletedReplay(
  request: { aihubCompletedReplay?: CompletedReplayForRequest },
  operation: IdempotencyOperation,
  idempotencyKey: string | undefined,
): CompletedIdempotencyReplay | undefined {
  const replay = request.aihubCompletedReplay;
  delete request.aihubCompletedReplay;
  return replay?.operation === operation &&
    replay.idempotencyKey === idempotencyKey
    ? replay.replay
    : undefined;
}
