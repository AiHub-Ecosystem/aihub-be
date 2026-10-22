import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import { setDownstreamBreakerState } from '@/common/observability/downstream-breaker-metrics';
import { getMetrics } from '@/common/observability/metrics';
import type { InternalAIServiceResponse } from '@/downstream/downstream.types';
import { DownstreamCircuitBreakers } from './downstream-circuit-breakers';

const OK: InternalAIServiceResponse<unknown> = {
  status: 200,
  headers: {},
  body: {},
};

async function breakerState(operation: string): Promise<string | undefined> {
  const prefix = `aihub_breaker_state{operation="${operation}"} `;
  const line = (await getMetrics())
    .split('\n')
    .find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length);
}

async function ignoreFailure(
  breakers: DownstreamCircuitBreakers,
  operation: 'writing.task1.grade' | 'writing.task2.grade' | 'speaking.grading',
  error: AppError,
): Promise<void> {
  await breakers
    .execute(operation, async () => {
      throw error;
    })
    .catch(() => undefined);
}

describe('DownstreamCircuitBreakers', () => {
  let breakers: DownstreamCircuitBreakers | undefined;

  afterEach(() => {
    breakers?.onModuleDestroy();
    breakers = undefined;
    jest.useRealTimers();
  });

  it('does not export metric labels for operations outside the catalog', async () => {
    setDownstreamBreakerState('unregistered.operation' as OperationId, 1);

    expect(await getMetrics()).not.toContain(
      'operation="unregistered.operation"',
    );
  });

  it('opens only the affected operation after concurrent failures', async () => {
    const instance = (breakers = new DownstreamCircuitBreakers());
    const failure = new AppError({
      code: 'AI_SERVICE_ERROR',
      message: 'provider failed',
      retryable: true,
      downstreamStatus: 503,
    });

    await Promise.all(
      Array.from({ length: 20 }, () =>
        ignoreFailure(instance, 'writing.task1.grade', failure),
      ),
    );
    expect(await breakerState('writing.task1.grade')).toBe('1');
    await expect(
      instance.execute('writing.task2.grade', async () => OK),
    ).resolves.toBe(OK);

    expect(await breakerState('writing.task1.grade')).toBe('1');
    expect(await breakerState('writing.task2.grade')).toBe('0');
  });

  it('does not open before 20 calls in the rolling window', async () => {
    const instance = (breakers = new DownstreamCircuitBreakers());
    const failure = new AppError({
      code: 'AI_SERVICE_UNAVAILABLE',
      message: 'unavailable',
      retryable: true,
    });

    for (let index = 0; index < 19; index += 1) {
      await ignoreFailure(instance, 'writing.task1.grade', failure);
    }

    expect(await breakerState('writing.task1.grade')).toBe('0');
  });

  it('counts downstream timeouts as service failures', async () => {
    const instance = (breakers = new DownstreamCircuitBreakers());
    const timeout = new AppError({
      code: 'AI_SERVICE_TIMEOUT',
      message: 'downstream timed out',
      retryable: true,
    });

    for (let index = 0; index < 20; index += 1) {
      await ignoreFailure(instance, 'writing.task1.grade', timeout);
    }

    expect(await breakerState('writing.task1.grade')).toBe('1');
  });

  it('does not count downstream 4xx responses as service failures', async () => {
    breakers = new DownstreamCircuitBreakers();
    const invalidRequest = new AppError({
      code: 'AI_SERVICE_ERROR',
      message: 'invalid downstream request',
      retryable: false,
      downstreamStatus: 400,
    });

    for (let index = 0; index < 25; index += 1) {
      await ignoreFailure(breakers, 'writing.task1.grade', invalidRequest);
    }

    expect(await breakerState('writing.task1.grade')).toBe('0');
  });

  it('does not count the captured unreadable-audio client error from a provider 500', async () => {
    const instance = (breakers = new DownstreamCircuitBreakers());
    const unreadableAudio = new AppError({
      code: 'AUDIO_UNREADABLE',
      message: 'The audio could not be read',
      retryable: false,
      downstreamStatus: 500,
    });

    for (let index = 0; index < 20; index += 1) {
      await ignoreFailure(instance, 'speaking.grading', unreadableAudio);
    }

    expect(await breakerState('speaking.grading')).toBe('0');
  });

  it('admits one half-open probe and returns the retry hint for blocked calls', async () => {
    jest.useFakeTimers();
    breakers = new DownstreamCircuitBreakers();
    const failure = new AppError({
      code: 'AI_SERVICE_UNAVAILABLE',
      message: 'unavailable',
      retryable: true,
    });
    for (let index = 0; index < 20; index += 1) {
      await ignoreFailure(breakers, 'writing.task1.grade', failure);
    }
    expect(await breakerState('writing.task1.grade')).toBe('1');

    await jest.advanceTimersByTimeAsync(30_000);
    expect(await breakerState('writing.task1.grade')).toBe('2');

    let completeProbe:
      | ((response: InternalAIServiceResponse<unknown>) => void)
      | undefined;
    const probe = breakers.execute(
      'writing.task1.grade',
      () =>
        new Promise((resolve) => {
          completeProbe = resolve;
        }),
    );
    const blocked = await breakers
      .execute('writing.task1.grade', async () => OK)
      .catch((error: unknown) => error);

    expect(blocked).toMatchObject({
      code: 'AI_SERVICE_UNAVAILABLE',
      retryable: true,
      retryAfterMs: 30_000,
    });
    expect(await breakerState('writing.task1.grade')).toBe('2');
    completeProbe?.(OK);
    await expect(probe).resolves.toBe(OK);
    expect(await breakerState('writing.task1.grade')).toBe('0');
  });
});
