import type { ConcurrencyLease } from '@/modules/gateway/application/concurrency-limiter.port';

export interface ConcurrencyPermit {
  holdForBackground(): void;
  responseFinished(): Promise<void>;
  requestFinished(): Promise<void>;
  backgroundFinished(): Promise<void>;
}

export interface ConcurrencyBackgroundLifecycle {
  started(): void;
  settled(): void;
}

declare module 'fastify' {
  interface FastifyRequest {
    aihubConcurrency?: ConcurrencyPermit;
  }
}

export function createConcurrencyPermit(
  lease: ConcurrencyLease,
): ConcurrencyPermit {
  let backgroundStarted = false;
  let backgroundSettled = false;
  let requestSettled = false;
  let released = false;

  const releaseIfSettled = async (): Promise<void> => {
    if (
      released ||
      !requestSettled ||
      (backgroundStarted && !backgroundSettled)
    ) {
      return;
    }

    released = true;
    await lease.release();
  };

  return {
    holdForBackground: () => {
      backgroundStarted = true;
    },
    responseFinished: releaseIfSettled,
    requestFinished: async () => {
      requestSettled = true;
      await releaseIfSettled();
    },
    backgroundFinished: async () => {
      backgroundSettled = true;
      await releaseIfSettled();
    },
  };
}

export function getConcurrencyPermit(
  request: import('fastify').FastifyRequest,
): ConcurrencyPermit | undefined {
  return request.aihubConcurrency;
}

export function getConcurrencyBackgroundLifecycle(
  request: import('fastify').FastifyRequest,
): ConcurrencyBackgroundLifecycle | undefined {
  const permit = getConcurrencyPermit(request);
  if (permit === undefined) {
    return undefined;
  }

  return {
    started: () => permit.holdForBackground(),
    settled: () => {
      void permit.backgroundFinished().catch(() => undefined);
    },
  };
}
