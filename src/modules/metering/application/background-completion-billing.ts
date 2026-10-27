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
 */
export function billBackgroundCompletion(
  input: BackgroundCompletionBillingInput,
): BackgroundWorkLifecycle | undefined {
  const { evidence, inner } = input;
  if (evidence === undefined) {
    return inner;
  }
  const now = input.now ?? Date.now;

  return {
    started: () => inner?.started(),
    settled: async () => {
      await inner?.settled();
      input.onCompletionSettled?.();
    },
    // Awaited by the background work, so a shutdown drain does not close the
    // database under the one charge this grading carries.
    completed: async () => {
      await inner?.completed?.();
      await input.finalizer
        .finalize({
          requestId: backgroundCompletionRequestId(input.requestId),
          ...attributionFromEvidence(evidence),
          outcome: 'success',
          httpStatus: 200,
          totalMs: Math.max(0, now() - input.receivedAt.getTime()),
          modelCalled: true,
          billingBasis: 'background_completion',
        })
        .catch(() => undefined);
    },
  };
}

/** The record id: the request it completes, so the two read side by side. */
export function backgroundCompletionRequestId(requestId: string): string {
  return `${requestId}:background`;
}
