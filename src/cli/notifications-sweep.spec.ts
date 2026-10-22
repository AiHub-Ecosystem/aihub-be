import type { ApiKeyNearExpiryNoticeRecordPort } from '@/modules/identity/notifications/application/api-key-near-expiry-notice.port';

import { runNotificationsSweepCommand } from './notifications-sweep';

const NOW = new Date('2026-10-22T03:00:00.000Z');

function records(): ApiKeyNearExpiryNoticeRecordPort & {
  calls: { now: Date; windowEnd: Date; eventId: string; emailId: string }[];
  closed: number;
  close(): Promise<void>;
} {
  const calls: {
    now: Date;
    windowEnd: Date;
    eventId: string;
    emailId: string;
  }[] = [];
  const fake = {
    calls,
    closed: 0,
    recordDue: async (
      input: Parameters<ApiKeyNearExpiryNoticeRecordPort['recordDue']>[0],
    ) => {
      calls.push({
        now: input.now,
        windowEnd: input.windowEnd,
        eventId: input.newEventId(input.now),
        emailId: input.newEmailDeliveryId(input.now),
      });
      return { eventsRecorded: 2, emailsQueued: 3, keysSkipped: 1 };
    },
    close: async () => {
      fake.closed += 1;
    },
  };
  return fake;
}

describe('notifications:sweep', () => {
  it('runs the near-expiry sweep once and prints one summary line', async () => {
    const store = records();
    const lines: string[] = [];

    const summary = await runNotificationsSweepCommand({
      databaseUrl: '',
      records: store,
      emit: (line) => lines.push(line),
      now: () => NOW,
    });

    expect(summary).toEqual({
      eventsRecorded: 2,
      emailsQueued: 3,
      keysSkipped: 1,
    });
    expect(lines).toEqual([
      JSON.stringify({ eventsRecorded: 2, emailsQueued: 3, keysSkipped: 1 }),
    ]);
    expect(store.calls).toEqual([
      {
        now: NOW,
        windowEnd: new Date('2026-11-05T03:00:00.000Z'),
        eventId: expect.stringMatching(/^nev_[0-9A-HJKMNP-TV-Z]{26}$/),
        emailId: expect.stringMatching(/^edr_[0-9A-HJKMNP-TV-Z]{26}$/),
      },
    ]);
    expect(store.closed).toBe(1);
  });

  it('closes the store when the sweep fails', async () => {
    const store = records();
    store.recordDue = async () => {
      throw new Error('identity store is unavailable');
    };

    await expect(
      runNotificationsSweepCommand({
        databaseUrl: '',
        records: store,
        emit: () => undefined,
        now: () => NOW,
      }),
    ).rejects.toThrow('identity store is unavailable');
    expect(store.closed).toBe(1);
  });
});
