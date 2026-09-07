import { AppError } from '../../../common/errors/app-error';
import {
  type IdempotencyFingerprintInput,
  createIdempotencyFingerprint,
} from './idempotency-fingerprint';
import type {
  CompleteIdempotencyInput,
  IdempotencyAttemptInput,
  IdempotencyRepositoryPort,
} from './idempotency-repository.port';
import type {
  IdempotencyExecution,
  IdempotencyExecutionInput,
  IdempotencyReplayDecoder,
  IdempotencyServicePort,
  IdempotencyWork,
  IdempotencyWorkContext,
} from './idempotency-service.port';

export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;

class ResponseDeadlineReached extends Error {}
class HardDeadlineReached extends Error {}

function conflictError(): AppError {
  return new AppError({
    code: 'IDEMPOTENCY_CONFLICT',
    message:
      'The idempotency key is already used for a different or pending request',
    httpStatus: 409,
    retryable: false,
  });
}

function timeoutError(): AppError {
  return new AppError({
    code: 'AI_SERVICE_TIMEOUT',
    message: 'AI service request timed out',
    httpStatus: 504,
    retryable: true,
  });
}

function storageError(cause: unknown): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Idempotency storage is unavailable',
    httpStatus: 500,
    retryable: true,
    cause,
  });
}

function malformedReplayError(cause: unknown): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Stored idempotency response is invalid',
    httpStatus: 500,
    retryable: false,
    cause,
  });
}

function isClientError(error: unknown): boolean {
  const downstreamStatus =
    error instanceof AppError ? error.downstreamStatus : undefined;
  return (
    error instanceof AppError &&
    ((error.httpStatus >= 400 && error.httpStatus < 500) ||
      (downstreamStatus !== undefined &&
        downstreamStatus >= 400 &&
        downstreamStatus < 500))
  );
}

function clearTimer(timer: ReturnType<typeof setTimeout>): void {
  clearTimeout(timer);
}

export class IdempotencyService implements IdempotencyServicePort {
  constructor(
    private readonly repository: IdempotencyRepositoryPort,
    private readonly now: () => number = Date.now,
  ) {}

  async execute<T>(
    input: IdempotencyExecutionInput,
    work: IdempotencyWork<T>,
    decodeReplay: IdempotencyReplayDecoder<T>,
  ): Promise<IdempotencyExecution<T>> {
    const fingerprintInput: IdempotencyFingerprintInput = {
      organizationId: input.organizationId,
      operation: input.operation,
      actorId: input.actorId,
      requestBody: input.requestBody,
    };
    const reservation = await this.reserve({
      organizationId: input.organizationId,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      fingerprintHex: createIdempotencyFingerprint(fingerprintInput),
      requestId: input.requestId,
      expiresAt: new Date(this.now() + IDEMPOTENCY_RETENTION_MS),
    });

    if (reservation.kind === 'conflict') {
      throw conflictError();
    }

    if (reservation.kind === 'replay') {
      if (
        reservation.responseStatus < 200 ||
        reservation.responseStatus >= 300
      ) {
        throw malformedReplayError(
          new Error('stored idempotency response status is not successful'),
        );
      }

      try {
        return { result: decodeReplay(reservation.responseBody), replay: true };
      } catch (error) {
        throw malformedReplayError(error);
      }
    }

    return this.executeClaimed(input, reservation.requestId, work);
  }

  private async reserve(
    input: Parameters<IdempotencyRepositoryPort['reserve']>[0],
  ) {
    try {
      return await this.repository.reserve(input);
    } catch (error) {
      throw storageError(error);
    }
  }

  private async executeClaimed<T>(
    input: IdempotencyExecutionInput,
    requestId: string,
    work: IdempotencyWork<T>,
  ): Promise<IdempotencyExecution<T>> {
    const hardTimeoutMs = input.timeoutMs * 2;
    const hardDeadlineAt = new Date(this.now() + hardTimeoutMs);
    const controller = new AbortController();
    let rejectHardDeadline: ((error: unknown) => void) | undefined;
    const hardDeadline = new Promise<never>((_, reject) => {
      rejectHardDeadline = reject;
    });
    const hardTimer = setTimeout(() => {
      controller.abort();
      rejectHardDeadline?.(new HardDeadlineReached());
    }, hardTimeoutMs);
    const workContext: IdempotencyWorkContext = {
      signal: controller.signal,
      deadlineAt: hardDeadlineAt,
    };
    const workPromise = Promise.resolve().then(() => work(workContext));
    let responseTimer: ReturnType<typeof setTimeout> | undefined;
    let background = false;

    try {
      const responseDeadline = new Promise<never>((_, reject) => {
        responseTimer = setTimeout(
          () => reject(new ResponseDeadlineReached()),
          input.timeoutMs,
        );
      });
      const result = await Promise.race([workPromise, responseDeadline]);
      if (responseTimer !== undefined) {
        clearTimer(responseTimer);
      }
      clearTimer(hardTimer);
      await this.complete(input, requestId, result);
      return { result, replay: false };
    } catch (error) {
      if (error instanceof ResponseDeadlineReached) {
        background = true;
        void this.finishInBackground(
          input,
          requestId,
          workPromise,
          hardDeadline,
          controller,
          hardTimer,
        );
        throw timeoutError();
      }

      if (responseTimer !== undefined) {
        clearTimer(responseTimer);
      }
      clearTimer(hardTimer);
      controller.abort();
      await this.releaseAfterFailure(input, requestId, error);
      throw error;
    } finally {
      if (responseTimer !== undefined) {
        clearTimer(responseTimer);
      }
      if (!background) {
        clearTimer(hardTimer);
      }
    }
  }

  private async finishInBackground<T>(
    input: IdempotencyExecutionInput,
    requestId: string,
    workPromise: Promise<T>,
    hardDeadline: Promise<never>,
    controller: AbortController,
    hardTimer: ReturnType<typeof setTimeout>,
  ): Promise<void> {
    try {
      const result = await Promise.race([workPromise, hardDeadline]);
      await this.complete(input, requestId, result);
    } catch (error) {
      await this.releaseAfterFailure(input, requestId, error);
    } finally {
      clearTimer(hardTimer);
      controller.abort();
    }
  }

  private async complete<T>(
    input: IdempotencyExecutionInput,
    requestId: string,
    result: T,
  ): Promise<void> {
    const completeInput: CompleteIdempotencyInput = {
      organizationId: input.organizationId,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestId,
      responseStatus: 200,
      responseBody: result,
    };
    try {
      await this.repository.complete(completeInput);
    } catch (error) {
      try {
        await this.repository.markFailed(completeInput);
      } catch {
        // The expiry window still allows a later attempt to reclaim the row.
      }
      throw storageError(error);
    }
  }

  private async releaseAfterFailure(
    input: IdempotencyExecutionInput,
    requestId: string,
    error: unknown,
  ): Promise<void> {
    const attempt: IdempotencyAttemptInput = {
      organizationId: input.organizationId,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestId,
    };
    try {
      if (isClientError(error)) {
        await this.repository.delete(attempt);
      } else {
        await this.repository.markFailed(attempt);
      }
    } catch {
      // Keep the original downstream/client error; expiry makes the attempt reclaimable.
    }
  }
}
