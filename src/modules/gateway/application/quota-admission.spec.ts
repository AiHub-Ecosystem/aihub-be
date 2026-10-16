import { AppError } from '@/common/errors/app-error';
import { admitMonthlyQuota } from './quota-admission';
import type { QuotaCounterPort } from './quota-counter.port';

const now = () => new Date('2026-09-16T12:00:00.000Z');

function counter(read: () => Promise<number>): QuotaCounterPort {
  return { read, increment: async () => undefined };
}

function input(hardStopOnQuota: boolean, quota = 5) {
  return { organizationId: 'org_test', quota, hardStopOnQuota };
}

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected refusal');
}

describe('admitMonthlyQuota', () => {
  it('admits a verified count under the quota', async () => {
    await expect(
      admitMonthlyQuota(
        counter(async () => 4),
        input(false),
        now,
      ),
    ).resolves.toBe('verified');
  });

  it('refuses a count at the quota with the time left in the month', async () => {
    const error = await refusal(
      admitMonthlyQuota(
        counter(async () => 5),
        input(false),
        now,
      ),
    );

    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(error.retryAfterMs).toBe(14 * 24 * 3_600_000 + 12 * 3_600_000);
  });

  it.each([
    ['rejects', async () => Promise.reject(new Error('redis down'))],
    ['returns a negative count', async () => -1],
    ['returns a fractional count', async () => 1.5],
    ['returns NaN', async () => Number.NaN],
  ])(
    'admits as unverified, never as zero, when the counter %s',
    async (_name, read) => {
      await expect(
        admitMonthlyQuota(counter(read), input(false), now),
      ).resolves.toBe('unverified');
    },
  );

  it('refuses when the counter is unreadable and the quota is a hard stop', async () => {
    const error = await refusal(
      admitMonthlyQuota(
        counter(async () => Promise.reject(new Error('redis down'))),
        input(true),
        now,
      ),
    );

    expect(error.code).toBe('QUOTA_EXCEEDED');
  });
});
