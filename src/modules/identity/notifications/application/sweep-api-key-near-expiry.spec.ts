import type { ApiKeyNearExpiryNoticeRecordPort } from './api-key-near-expiry-notice.port';
import { SweepApiKeyNearExpiry } from './sweep-api-key-near-expiry';

describe('SweepApiKeyNearExpiry', () => {
  it('records notices for keys expiring within the next fourteen days', async () => {
    const calls: { now: Date; windowEnd: Date }[] = [];
    const records: ApiKeyNearExpiryNoticeRecordPort = {
      recordDue: async (input) => {
        calls.push({ now: input.now, windowEnd: input.windowEnd });
        return { eventsRecorded: 1, emailsQueued: 2, keysSkipped: 0 };
      },
    };
    const now = new Date('2026-10-22T00:00:00.000Z');

    const summary = await new SweepApiKeyNearExpiry(records, () => 'nev_x').run(
      now,
    );

    expect(calls).toEqual([
      { now, windowEnd: new Date('2026-11-05T00:00:00.000Z') },
    ]);
    expect(summary).toEqual({
      eventsRecorded: 1,
      emailsQueued: 2,
      keysSkipped: 0,
    });
  });
});
