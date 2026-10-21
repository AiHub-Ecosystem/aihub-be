import {
  backgroundWorkSettled,
  backgroundWorkStarted,
} from '@/common/http/background-work-drain';
import type { ConcurrencyLease } from '@/modules/gateway/application/concurrency-limiter.port';

export interface ConcurrencyPermit {
  holdForBackground(): void;
  responseFinished(): Promise<void>;
  requestFinished(): Promise<void>;
  backgroundFinished(): Promise<void>;
  isReleased(): boolean;
}

export interface ConcurrencyBackgroundLifecycle {
  started(): void;
  settled(): Promise<void>;
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
  let releaseAttempt: Promise<void> | undefined;
  let released = false;

  const releaseIfSettled = (): Promise<void> => {
    if (releaseAttempt !== undefined) return releaseAttempt;
    if (!requestSettled || (backgroundStarted && !backgroundSettled)) {
      return Promise.resolve();
    }

    releaseAttempt = Promise.resolve()
      .then(() => lease.release())
      .then(() => {
        released = true;
        return undefined;
      });
    return releaseAttempt;
  };

  return {
    holdForBackground: () => {
      if (backgroundStarted) {
        return;
      }
      backgroundStarted = true;
      backgroundWorkStarted();
    },
    responseFinished: releaseIfSettled,
    requestFinished: () => {
      requestSettled = true;
      return releaseIfSettled();
    },
    backgroundFinished: async () => {
      if (backgroundSettled) return releaseAttempt ?? Promise.resolve();
      backgroundSettled = true;
      try {
        await releaseIfSettled();
      } finally {
        if (backgroundStarted) {
          backgroundWorkSettled();
        }
      }
    },
    isReleased: () => released,
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
    settled: () => permit.backgroundFinished(),
  };
}
