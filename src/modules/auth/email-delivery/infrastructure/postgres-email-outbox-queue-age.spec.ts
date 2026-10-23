import type { EmailDeliveryBacklogRow } from './postgres-email-delivery-request.repository';
import {
  PostgresEmailOutboxQueueAge,
  QUEUE_AGE_CACHE_MS,
} from './postgres-email-outbox-queue-age';

const ROWS: readonly EmailDeliveryBacklogRow[] = [
  { kind: 'verification_email', queued: 3, oldestAgeSeconds: 120 },
];

function readerOf(
  results: readonly (readonly EmailDeliveryBacklogRow[] | Error)[],
) {
  let calls = 0;
  return {
    get calls(): number {
      return calls;
    },
    async backlog(): Promise<readonly EmailDeliveryBacklogRow[]> {
      const next = results[Math.min(calls, results.length - 1)] ?? [];
      calls += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe('PostgresEmailOutboxQueueAge', () => {
  it('reports the oldest age of a kind in seconds, and nothing for a kind with no queued row', async () => {
    const age = new PostgresEmailOutboxQueueAge(readerOf([ROWS]));

    await expect(
      age.oldestQueuedAgeSeconds('verification_email'),
    ).resolves.toBe(120);
    await expect(
      age.oldestQueuedAgeSeconds('password_reset_email'),
    ).resolves.toBeUndefined();
  });

  it('serves concurrent and nearby requests from one read, then reads again', async () => {
    let now = new Date('2026-10-23T12:00:00.000Z');
    const reader = readerOf([ROWS]);
    const age = new PostgresEmailOutboxQueueAge(reader, () => now);

    await Promise.all([
      age.oldestQueuedAgeSeconds('verification_email'),
      age.oldestQueuedAgeSeconds('verification_email'),
    ]);
    now = new Date(now.getTime() + QUEUE_AGE_CACHE_MS - 1);
    await age.oldestQueuedAgeSeconds('verification_email');
    expect(reader.calls).toBe(1);

    now = new Date(now.getTime() + 1);
    await age.oldestQueuedAgeSeconds('verification_email');
    expect(reader.calls).toBe(2);
  });

  it('does not cache a failed read', async () => {
    const reader = readerOf([new Error('database down'), ROWS]);
    const age = new PostgresEmailOutboxQueueAge(reader);

    await expect(
      age.oldestQueuedAgeSeconds('verification_email'),
    ).rejects.toThrow('database down');
    await expect(
      age.oldestQueuedAgeSeconds('verification_email'),
    ).resolves.toBe(120);
  });
});
