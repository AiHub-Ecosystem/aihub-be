import {
  type MeteringEvidence,
  attributionFromEvidence,
} from './metering-evidence';
import type { MeteringFinalizerPort } from './metering-finalizer.port';

/** Structurally the idempotency background lifecycle, without importing it. */
export interface BackgroundWorkLifecycle {
  started(): void;
  settled(): void | Promise<void>;
  completed?(): void | Promise<void>;
}

export interface BackgroundCompletionBillingInput {
  readonly requestId: string;
  readonly receivedAt: Date;
  readonly evidence: MeteringEvidence | undefined;
  readonly finalizer: MeteringFinalizerPort;
  readonly inner?: BackgroundWorkLifecycle;
  readonly onCompletionSettled?: () => void;
  readonly now?: () => number;
  /**
   * How long the inner completion may hold the billing step before the billing
   * write proceeds without it (#944). The billing write is the one charge this
   * grading carries; a listener that stalls cannot be allowed to postpone it
   * forever. Defaults to 100ms.
   */
  readonly innerCompletedTimeoutMs?: number;
}

const DEFAULT_INNER_COMPLETED_TIMEOUT_MS = 100;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

/**
 * The one charge for a grading AIHUB finished after answering `504`
 * (ADR-0097, #405).
 *
 * The `504` record stays what the caller saw: a non-billable downstream
 * failure. When the background work later stores its result, this writes a
 * second record under its own id, billed once and counted against quota once.
 * Replays of that stored result remain non-billable, so no number of retries
 * charges again.
 *
 * Lifecycle ordering (#944): billing is written *before* the inner completion
 * is awaited, and the inner completion is raced against
 * `innerCompletedTimeoutMs`. A throwing or stalled inner listener therefore
 * cannot skip billing or delay it forever. A failed billing write rejects out
 * of `completed` after the inner completion still runs, and leaves the
 * evidence unsettled so #510's durable recovery can find the missing usage.
 * This ordering alone does not recover a process killed between result
 * persistence and charging — that gap is #510's, not this callback's.
 */
export function billBackgroundCompletion(
  input: BackgroundCompletionBillingInput,
): BackgroundWorkLifecycle | undefined {
  const { evidence, inner } = input;
  if (evidence === undefined) {
    return inner;
  }
  const now = input.now ?? Date.now;
  const innerCompletedTimeoutMs =
    input.innerCompletedTimeoutMs ?? DEFAULT_INNER_COMPLETED_TIMEOUT_MS;

  return {
    started: () => inner?.started(),
    settled: async () => {
      await inner?.settled();
      input.onCompletionSettled?.();
    },
    // Awaited by the background work, so a shutdown drain does not close the
    // database under the one charge this grading carries.
    completed: async () => {
      // Start the inner completion first so it can finish in parallel, but
      // do not let it gate the billing write: race it against a timeout and
      // swallow its failure — the stored result is already durable, and the
      // charge below is the one this grading owes.
      const innerCompleted = Promise.resolve()
        .then(() => inner?.completed?.())
        .catch(() => undefined);

      let billingError: unknown;
      try {
        await input.finalizer.finalize({
          requestId: backgroundCompletionRequestId(input.requestId),
          ...attributionFromEvidence(evidence),
          outcome: 'success',
          httpStatus: 200,
          totalMs: Math.max(0, now() - input.receivedAt.getTime()),
          modelCalled: true,
          billingBasis: 'background_completion',
        });
        evidence.settled = true;
      } catch (error) {
        billingError = error;
        evidence.settled = false;
      }

      await withTimeout(innerCompleted, innerCompletedTimeoutMs);

      if (billingError !== undefined) {
        throw billingError;
      }
    },
  };
}

/** The record id: the request it completes, so the two read side by side. */
export function backgroundCompletionRequestId(requestId: string): string {
  return `${requestId}:background`;
}
