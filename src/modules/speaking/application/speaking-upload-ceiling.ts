import { AppError } from '@/common/errors/app-error';
import { outageRetryAfterMs } from '@/common/errors/retry-jitter';

/**
 * Multipart Speaking gradings one process runs at once (#270). Each holds one
 * buffered audio file of up to 25 MiB from upload until the downstream answer,
 * so this bounds that memory inside the app container's 768 MiB limit whatever
 * concurrency the organizations are allowed.
 *
 * ponytail: a fixed per-process count; make it configuration if the container
 * memory limit or the process count changes.
 */
export const SPEAKING_UPLOADS_IN_FLIGHT_MAX = 8;

export const SPEAKING_UPLOAD_CEILING = Symbol('SPEAKING_UPLOAD_CEILING');

export class InFlightCeiling {
  private inFlight = 0;

  constructor(private readonly max: number) {}

  /**
   * Takes a slot, or refuses with the gateway's retryable concurrency error.
   * The returned function frees the slot; calling it again does nothing.
   */
  enter(): () => void {
    if (this.inFlight >= this.max) {
      throw new AppError({
        code: 'CONCURRENCY_LIMIT',
        message: 'Concurrency limit exceeded',
        retryable: true,
        // A full-size grading takes seconds, not minutes.
        retryAfterMs: outageRetryAfterMs(),
      });
    }

    this.inFlight += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.inFlight -= 1;
      }
    };
  }
}
