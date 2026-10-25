import { calculateWritingChartRevocationAuditCutoff } from '@/modules/writing/public/chart-revocation';

import {
  UsagePruneError,
  calculateUsageRetentionCutoff,
} from './usage-retention';

/**
 * The one month-anchored cutoff arithmetic, pinned through both consumers so
 * a leap-day or anchoring fix reaches every retention rule at once. Each
 * consumer states its own length beside the policy that owns it (ADR-0023 for
 * the 13-month usage horizon, ADR-0111 for the 24-month writing chart
 * revocation audit), and rejects an invalid clock with its own error: the
 * rejection type is the one thing the two are allowed to differ on.
 */
interface CutoffCase {
  readonly name: string;
  readonly now: string;
  readonly usage: string;
  readonly writing: string;
}

const CASES: readonly CutoffCase[] = [
  {
    name: 'preserves the day and time of day across whole years',
    now: '2026-10-19T12:00:00.000Z',
    usage: '2025-09-19T12:00:00.000Z',
    writing: '2024-10-19T12:00:00.000Z',
  },
  {
    name: 'preserves a leap day into a month that has it',
    now: '2024-02-29T02:30:00.000Z',
    usage: '2023-01-29T02:30:00.000Z',
    writing: '2022-02-28T02:30:00.000Z',
  },
  {
    name: 'clamps the last day of a long month into a shorter target month',
    now: '2024-03-31T02:30:00.000Z',
    usage: '2023-02-28T02:30:00.000Z',
    writing: '2022-03-31T02:30:00.000Z',
  },
  {
    name: 'lands on the leap day itself when the target February has one',
    now: '2025-03-31T02:30:00.000Z',
    usage: '2024-02-29T02:30:00.000Z',
    writing: '2023-03-31T02:30:00.000Z',
  },
  {
    name: 'crosses the year boundary twice for the 13-month horizon',
    now: '2026-01-15T00:00:00.000Z',
    usage: '2024-12-15T00:00:00.000Z',
    writing: '2024-01-15T00:00:00.000Z',
  },
];

describe('the month-anchored retention cutoff', () => {
  it.each(CASES)('$name', ({ now, usage, writing }) => {
    expect(calculateUsageRetentionCutoff(new Date(now))).toEqual(
      new Date(usage),
    );
    expect(calculateWritingChartRevocationAuditCutoff(new Date(now))).toEqual(
      new Date(writing),
    );
  });

  it('usage retention rejects an invalid clock as its own safe internal failure', () => {
    expect(() => calculateUsageRetentionCutoff(new Date('not-a-date'))).toThrow(
      UsagePruneError,
    );
    expect(() => calculateUsageRetentionCutoff(new Date('not-a-date'))).toThrow(
      'usage retention clock is invalid',
    );
  });

  it('writing chart revocation audit rejects an invalid clock as its own plain error', () => {
    let caught: unknown;
    try {
      calculateWritingChartRevocationAuditCutoff(new Date('not-a-date'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UsagePruneError);
    expect(caught).toMatchObject({
      message: 'Writing chart revocation audit clock is invalid',
    });
  });
});
