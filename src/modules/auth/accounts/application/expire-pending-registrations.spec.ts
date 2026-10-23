import {
  ExpirePendingRegistrations,
  PENDING_REGISTRATION_BATCH_SIZE,
  PENDING_REGISTRATION_LIFETIME_MS,
  PENDING_REGISTRATION_MAX_BATCHES,
  type PendingRegistrationRecordPort,
} from './expire-pending-registrations';

const NOW = new Date('2026-10-30T00:00:00.000Z');

class FakeRecords implements PendingRegistrationRecordPort {
  readonly calls: { expiredAtOrBefore: Date; limit: number }[] = [];
  constructor(private readonly answers: number[]) {}

  async deleteExpiredPending(input: {
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<number> {
    this.calls.push({ ...input });
    return this.answers.shift() ?? 0;
  }
}

describe('ExpirePendingRegistrations', () => {
  it('deletes what was registered or replaced more than seven days ago', async () => {
    const records = new FakeRecords([3]);

    await new ExpirePendingRegistrations(records).run(NOW);

    expect(PENDING_REGISTRATION_LIFETIME_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(records.calls).toEqual([
      {
        expiredAtOrBefore: new Date('2026-10-23T00:00:00.000Z'),
        limit: PENDING_REGISTRATION_BATCH_SIZE,
      },
    ]);
  });

  it('reports the count and stops at the first short batch', async () => {
    const records = new FakeRecords([PENDING_REGISTRATION_BATCH_SIZE, 7]);

    await expect(
      new ExpirePendingRegistrations(records).run(NOW),
    ).resolves.toEqual({
      deleted: PENDING_REGISTRATION_BATCH_SIZE + 7,
      batches: 2,
    });
    expect(records.calls).toHaveLength(2);
  });

  it('reports nothing deleted when nothing has expired', async () => {
    const records = new FakeRecords([0]);

    await expect(
      new ExpirePendingRegistrations(records).run(NOW),
    ).resolves.toEqual({ deleted: 0, batches: 1 });
  });

  it('stops after the batch cap so one run stays bounded', async () => {
    const records = new FakeRecords(
      Array.from(
        { length: PENDING_REGISTRATION_MAX_BATCHES + 5 },
        () => PENDING_REGISTRATION_BATCH_SIZE,
      ),
    );

    const summary = await new ExpirePendingRegistrations(records).run(NOW);

    expect(summary.batches).toBe(PENDING_REGISTRATION_MAX_BATCHES);
    expect(records.calls).toHaveLength(PENDING_REGISTRATION_MAX_BATCHES);
  });
});
