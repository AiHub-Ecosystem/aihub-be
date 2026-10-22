import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import CircuitBreaker from 'opossum';

import { OPERATION_IDS, type OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import { setDownstreamBreakerState } from '@/common/observability/downstream-breaker-metrics';
import type { InternalAIServiceResponse } from '@/downstream/downstream.types';

const WINDOW_MS = 10_000;
const RESET_TIMEOUT_MS = 30_000;

type DownstreamAction = () => Promise<InternalAIServiceResponse<unknown>>;
type OperationBreaker = CircuitBreaker<
  [action: DownstreamAction],
  InternalAIServiceResponse<unknown>
>;

function isCircuitFailure(error: unknown, operation: OperationId): boolean {
  if (!(error instanceof AppError)) return false;
  if (operation === 'speaking.grading' && error.code === 'AUDIO_UNREADABLE') {
    return false;
  }
  if (error.downstreamStatus !== undefined)
    return error.downstreamStatus >= 500;
  return (
    error.code === 'AI_SERVICE_TIMEOUT' ||
    error.code === 'AI_SERVICE_UNAVAILABLE'
  );
}

function isOpenBreakerError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && error.code === 'EOPENBREAKER'
  );
}

@Injectable()
export class DownstreamCircuitBreakers implements OnModuleDestroy {
  private readonly breakers: Map<OperationId, OperationBreaker>;
  private readonly openedAt = new Map<OperationId, number>();

  constructor() {
    this.breakers = new Map(
      OPERATION_IDS.map(
        (operation) => [operation, this.createBreaker(operation)] as const,
      ),
    );
  }

  async execute(
    operation: OperationId,
    action: DownstreamAction,
  ): Promise<InternalAIServiceResponse<unknown>> {
    let breaker = this.breakers.get(operation);
    if (breaker === undefined) {
      breaker = this.createBreaker(operation);
      this.breakers.set(operation, breaker);
    }

    try {
      return await breaker.fire(action);
    } catch (error) {
      if (!isOpenBreakerError(error)) throw error;
      const openedAt = this.openedAt.get(operation) ?? Date.now();
      const retryAfterMs = breaker.halfOpen
        ? RESET_TIMEOUT_MS
        : Math.max(1, RESET_TIMEOUT_MS - (Date.now() - openedAt));
      throw new AppError({
        code: 'AI_SERVICE_UNAVAILABLE',
        message: 'AI service is temporarily unavailable',
        retryable: true,
        retryAfterMs,
        cause: error,
      });
    }
  }

  onModuleDestroy(): void {
    for (const [operation, breaker] of this.breakers) {
      breaker.shutdown();
      setDownstreamBreakerState(operation, 0);
    }
    this.openedAt.clear();
  }

  private createBreaker(operation: OperationId): OperationBreaker {
    const breaker = new CircuitBreaker<
      [action: DownstreamAction],
      InternalAIServiceResponse<unknown>
    >((action) => action(), {
      errorThresholdPercentage: 50,
      volumeThreshold: 20,
      resetTimeout: RESET_TIMEOUT_MS,
      rollingCountTimeout: WINDOW_MS,
      timeout: false,
      errorFilter: (error) => !isCircuitFailure(error, operation),
      name: operation,
    });
    breaker.on('open', () => {
      this.openedAt.set(operation, Date.now());
      setDownstreamBreakerState(operation, 1);
    });
    breaker.on('halfOpen', () => {
      this.openedAt.delete(operation);
      setDownstreamBreakerState(operation, 2);
    });
    breaker.on('close', () => {
      this.openedAt.delete(operation);
      setDownstreamBreakerState(operation, 0);
    });
    setDownstreamBreakerState(operation, 0);
    return breaker;
  }
}
