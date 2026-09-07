import { AppError } from '../../../common/errors/app-error';
import type {
  CompleteIdempotencyInput,
  IdempotencyAttemptInput,
  IdempotencyRepositoryPort,
  IdempotencyReservation,
  ReserveIdempotencyInput,
} from './idempotency-repository.port';
import {
  IDEMPOTENCY_RETENTION_MS,
  IdempotencyService,
} from './idempotency-service';

class FakeRepository implements IdempotencyRepositoryPort {
  nextReservations: IdempotencyReservation[] = [];
  reserved: ReserveIdempotencyInput[] = [];
  completed: CompleteIdempotencyInput[] = [];
  failed: IdempotencyAttemptInput[] = [];
  deleted: IdempotencyAttemptInput[] = [];

  reserve(input: ReserveIdempotencyInput): Promise<IdempotencyReservation> {
    this.reserved.push(input);
    return Promise.resolve(
      this.nextReservations.shift() ?? {
        kind: 'claimed',
        requestId: input.requestId,
      },
    );
  }

  complete(input: CompleteIdempotencyInput): Promise<void> {
    this.completed.push(input);
    return Promise.resolve();
  }

  markFailed(input: IdempotencyAttemptInput): Promise<void> {
    this.failed.push(input);
    return Promise.resolve();
  }

  delete(input: IdempotencyAttemptInput): Promise<void> {
    this.deleted.push(input);
    return Promise.resolve();
  }

  cleanupExpired(): Promise<number> {
    return Promise.resolve(0);
  }
}

class AtomicRepository implements IdempotencyRepositoryPort {
  private claimed = false;
  completeCount = 0;

  async reserve(
    input: ReserveIdempotencyInput,
  ): Promise<IdempotencyReservation> {
    if (this.claimed) {
      return { kind: 'conflict', reason: 'pending' };
    }
    this.claimed = true;
    return { kind: 'claimed', requestId: input.requestId };
  }

  complete(_input: CompleteIdempotencyInput): Promise<void> {
    this.completeCount += 1;
    return Promise.resolve();
  }

  markFailed(_input: IdempotencyAttemptInput): Promise<void> {
    return Promise.resolve();
  }

  delete(_input: IdempotencyAttemptInput): Promise<void> {
    return Promise.resolve();
  }

  cleanupExpired(): Promise<number> {
    return Promise.resolve(0);
  }
}

function input(requestId = 'req_1') {
  return {
    organizationId: 'org_acme',
    operation: 'writing.task1.grade' as const,
    idempotencyKey: 'grade-1',
    actorId: 'user_1',
    requestBody: { answer: 'hello' },
    requestId,
    timeoutMs: 50,
  };
}

describe('IdempotencyService', () => {
  it('completes a first attempt and replays the stored result without running work again', async () => {
    const repository = new FakeRepository();
    const service = new IdempotencyService(repository, () => 1_000);
    const work = jest.fn(async () => ({ value: 'graded' }));

    const first = await service.execute(input(), work, (value) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('value' in value) ||
        typeof value.value !== 'string'
      ) {
        throw new Error('invalid replay');
      }
      return { value: value.value };
    });
    repository.nextReservations.push({
      kind: 'replay',
      responseStatus: 200,
      responseBody: { value: 'graded' },
    });
    const replay = await service.execute(input('req_2'), work, (value) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('value' in value) ||
        typeof value.value !== 'string'
      ) {
        throw new Error('invalid replay');
      }
      return { value: value.value };
    });

    expect(first).toEqual({ result: { value: 'graded' }, replay: false });
    expect(replay).toEqual({ result: { value: 'graded' }, replay: true });
    expect(work).toHaveBeenCalledTimes(1);
    expect(repository.completed).toHaveLength(1);
    expect(repository.reserved[0]?.expiresAt.getTime()).toBe(
      1_000 + IDEMPOTENCY_RETENTION_MS,
    );
  });

  it('turns a fingerprint or pending collision into a conflict', async () => {
    const repository = new FakeRepository();
    repository.nextReservations.push(
      { kind: 'conflict', reason: 'fingerprint' },
      { kind: 'conflict', reason: 'pending' },
    );
    const service = new IdempotencyService(repository);

    await expect(
      service.execute(
        input(),
        async () => ({ value: 'unused' }),
        () => ({ value: 'unused' }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 });
    await expect(
      service.execute(
        input(),
        async () => ({ value: 'unused' }),
        () => ({ value: 'unused' }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 });
  });

  it('deletes the reservation for a client error and keeps retryable failures failed', async () => {
    const repository = new FakeRepository();
    repository.nextReservations.push(
      { kind: 'claimed', requestId: 'req_client' },
      { kind: 'claimed', requestId: 'req_retryable' },
    );
    const service = new IdempotencyService(repository);
    const clientError = new AppError({
      code: 'INVALID_REQUEST',
      message: 'invalid',
      httpStatus: 400,
      retryable: false,
    });
    const downstreamError = new AppError({
      code: 'AI_SERVICE_UNAVAILABLE',
      message: 'unavailable',
      httpStatus: 503,
      retryable: true,
    });

    await expect(
      service.execute(
        input('req_client'),
        async () => {
          throw clientError;
        },
        () => ({ value: 'unused' }),
      ),
    ).rejects.toBe(clientError);
    await expect(
      service.execute(
        input('req_retryable'),
        async () => {
          throw downstreamError;
        },
        () => ({ value: 'unused' }),
      ),
    ).rejects.toBe(downstreamError);

    expect(repository.deleted).toHaveLength(1);
    expect(repository.deleted[0]?.requestId).toBe('req_client');
    expect(repository.failed).toHaveLength(1);
    expect(repository.failed[0]?.requestId).toBe('req_retryable');
  });

  it('returns timeout at the operation deadline while allowing sent work to complete in the background', async () => {
    const repository = new FakeRepository();
    repository.nextReservations.push(
      { kind: 'claimed', requestId: 'req_timeout' },
      { kind: 'conflict', reason: 'pending' },
    );
    const service = new IdempotencyService(repository);
    let resolveWork: ((value: { value: string }) => void) | undefined;
    const workPromise = new Promise<{ value: string }>((resolve) => {
      resolveWork = resolve;
    });

    await expect(
      service.execute(
        { ...input('req_timeout'), timeoutMs: 10 },
        () => workPromise,
        () => ({ value: 'unused' }),
      ),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_TIMEOUT', httpStatus: 504 });
    await expect(
      service.execute(
        { ...input('req_timeout_retry'), timeoutMs: 10 },
        async () => ({ value: 'unused' }),
        () => ({ value: 'unused' }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    resolveWork?.({ value: 'completed-after-timeout' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(repository.completed[0]?.responseBody).toEqual({
      value: 'completed-after-timeout',
    });
  });

  it('allows only one downstream execution when two requests race for one key', async () => {
    const repository = new AtomicRepository();
    const service = new IdempotencyService(repository);
    let downstreamCalls = 0;
    const work = async () => {
      downstreamCalls += 1;
      return { value: 'one-call' };
    };

    const results = await Promise.allSettled([
      service.execute(input('req_race_1'), work, () => ({ value: 'replay' })),
      service.execute(input('req_race_2'), work, () => ({ value: 'replay' })),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(downstreamCalls).toBe(1);
    expect(repository.completeCount).toBe(1);
  });

  it('marks a sent request failed at the hard deadline if the work ignores cancellation', async () => {
    const repository = new FakeRepository();
    repository.nextReservations.push({
      kind: 'claimed',
      requestId: 'req_hard',
    });
    const service = new IdempotencyService(repository);

    await expect(
      service.execute(
        { ...input('req_hard'), timeoutMs: 5 },
        () => new Promise<{ value: string }>(() => undefined),
        () => ({ value: 'unused' }),
      ),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_TIMEOUT' });

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(repository.failed[0]?.requestId).toBe('req_hard');
  });

  it('deletes the record when delayed downstream work eventually returns a 4xx', async () => {
    const repository = new FakeRepository();
    repository.nextReservations.push({
      kind: 'claimed',
      requestId: 'req_background_client_error',
    });
    const service = new IdempotencyService(repository);
    let rejectWork: ((error: unknown) => void) | undefined;
    const workPromise = new Promise<{ value: string }>((_, reject) => {
      rejectWork = reject;
    });
    const downstreamClientError = new AppError({
      code: 'AI_SERVICE_ERROR',
      message: 'downstream rejected the request',
      httpStatus: 502,
      retryable: false,
      downstreamStatus: 400,
    });

    await expect(
      service.execute(
        { ...input('req_background_client_error'), timeoutMs: 5 },
        () => workPromise,
        () => ({ value: 'unused' }),
      ),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_TIMEOUT' });

    rejectWork?.(downstreamClientError);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(repository.deleted[0]?.requestId).toBe(
      'req_background_client_error',
    );
    expect(repository.failed).toHaveLength(0);
  });
});
