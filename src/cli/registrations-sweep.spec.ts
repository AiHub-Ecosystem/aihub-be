import type { PendingRegistrationRecordPort } from '@/modules/auth/public/pending-registration-expiry';

import { runRegistrationsSweepCommand } from './registrations-sweep';

const NOW = new Date('2026-10-30T03:00:00.000Z');

function records(answers: number[]): PendingRegistrationRecordPort & {
  calls: { expiredAtOrBefore: Date; limit: number }[];
  closed: number;
  close(): Promise<void>;
} {
  const calls: { expiredAtOrBefore: Date; limit: number }[] = [];
  const fake = {
    calls,
    closed: 0,
    deleteExpiredPending: async (input: {
      readonly expiredAtOrBefore: Date;
      readonly limit: number;
    }) => {
      calls.push({ ...input });
      return answers.shift() ?? 0;
    },
    close: async () => {
      fake.closed += 1;
    },
  };
  return fake;
}

describe('registrations:sweep', () => {
  it('deletes registrations pending for seven days and prints one line of counts', async () => {
    const store = records([4]);
    const lines: string[] = [];

    const summary = await runRegistrationsSweepCommand({
      databaseUrl: '',
      records: store,
      emit: (line) => lines.push(line),
      now: () => NOW,
    });

    expect(summary).toEqual({ deleted: 4, batches: 1 });
    expect(lines).toEqual([JSON.stringify({ deleted: 4, batches: 1 })]);
    expect(store.calls[0]?.expiredAtOrBefore).toEqual(
      new Date('2026-10-23T03:00:00.000Z'),
    );
    expect(store.closed).toBe(1);
  });

  it('closes the store when the sweep fails', async () => {
    const store = records([]);
    store.deleteExpiredPending = async () => {
      throw new Error('auth store is unavailable');
    };

    await expect(
      runRegistrationsSweepCommand({
        databaseUrl: '',
        records: store,
        emit: () => undefined,
      }),
    ).rejects.toThrow('auth store is unavailable');
    expect(store.closed).toBe(1);
  });
});
