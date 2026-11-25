import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import {
  BACKGROUND_PAST_RESPONSE_TIMEOUTS,
  BACKGROUND_SLACK_MS,
  backgroundDrainMs,
  backgroundHardDeadlineMs,
  largestRequestTimeoutMs,
  requiredStopGraceMs,
} from './shutdown-budget';

const COMPOSE_FILE = resolve(process.cwd(), 'docker-compose.production.yml');
const UNIT_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000 };

// Every `stop_grace_period` in the file, so a per-service override cannot hide
// below the budget. Compose also allows `1m30s`; the file keeps a single unit.
function composeStopGracePeriodsMs(): number[] {
  const matches = [
    ...readFileSync(COMPOSE_FILE, 'utf8').matchAll(
      /^\s*stop_grace_period:\s*(\d+)([sm])\s*$/gm,
    ),
  ];
  return matches.map(
    ([, amount, unit]) => Number(amount) * (UNIT_MS[unit ?? ''] ?? Number.NaN),
  );
}

describe('shutdown budget', () => {
  it('sizes the background drain at the timeout plus 15 seconds', () => {
    expect(backgroundDrainMs(60_000)).toBe(75_000);
    expect(backgroundDrainMs(125_000)).toBe(140_000);
    expect(backgroundDrainMs(300_000)).toBe(315_000);
  });

  it('covers the 60-second baseline, Writing /v2, and Speaking /v2 shutdown budgets', () => {
    expect(requiredStopGraceMs(60_000)).toBe(150_000);
    expect(requiredStopGraceMs(125_000)).toBe(280_000);
    expect(requiredStopGraceMs(300_000)).toBe(630_000);
  });

  it('reaches every operation and timed public route timeout', () => {
    const largest = largestRequestTimeoutMs();
    const timeouts = [
      ...Object.values(OPERATION_CATALOG).map(({ timeoutMs }) => timeoutMs),
      ...Object.values(PUBLIC_ROUTES).flatMap((route) =>
        'timeoutMs' in route ? [route.timeoutMs] : [],
      ),
    ];

    expect(largest).toBeGreaterThanOrEqual(60_000);
    for (const timeoutMs of timeouts) {
      expect(largest).toBeGreaterThanOrEqual(timeoutMs);
    }
  });

  it('is covered by every stop_grace_period in the production compose file', () => {
    const periods = composeStopGracePeriodsMs();

    expect(periods.length).toBeGreaterThan(0);
    for (const period of periods) {
      expect(period).toBeGreaterThanOrEqual(
        requiredStopGraceMs(largestRequestTimeoutMs()),
      );
    }
  });

  it('is covered for the 300-second Speaking /v2 grading timeout', () => {
    expect(largestRequestTimeoutMs()).toBe(300_000);
    for (const period of composeStopGracePeriodsMs()) {
      expect(period).toBeGreaterThanOrEqual(requiredStopGraceMs(300_000));
    }
  });
});

describe('idempotency background hard deadline (#1660)', () => {
  it('states the policy as one response timeout after the response deadline', () => {
    expect(BACKGROUND_PAST_RESPONSE_TIMEOUTS).toBe(1);
    expect(backgroundHardDeadlineMs(50)).toBe(100);
  });

  it('keeps the hard deadline and shutdown wait budget aligned', () => {
    for (const timeoutMs of [5, 50, 60_000, 125_000, 300_000]) {
      const afterResponseMs = backgroundHardDeadlineMs(timeoutMs) - timeoutMs;

      expect(afterResponseMs).toBe(
        timeoutMs * BACKGROUND_PAST_RESPONSE_TIMEOUTS,
      );
      expect(backgroundDrainMs(timeoutMs)).toBe(
        afterResponseMs + BACKGROUND_SLACK_MS,
      );
    }
  });
});
