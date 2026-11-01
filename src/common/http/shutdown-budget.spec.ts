import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import {
  backgroundDrainMs,
  largestRequestTimeoutMs,
  requiredStopGraceMs,
} from './shutdown-budget';

const COMPOSE_FILE = join(__dirname, '../../../docker-compose.production.yml');

function composeStopGraceMs(): number {
  const match = /^\s*stop_grace_period:\s*(\d+)s\s*$/m.exec(
    readFileSync(COMPOSE_FILE, 'utf8'),
  );
  if (match?.[1] === undefined) {
    throw new Error('docker-compose.production.yml has no stop_grace_period');
  }
  return Number(match[1]) * 1_000;
}

describe('shutdown budget', () => {
  it('sizes the background drain at the timeout plus 15 seconds', () => {
    expect(backgroundDrainMs(60_000)).toBe(75_000);
    expect(backgroundDrainMs(125_000)).toBe(140_000);
  });

  it('keeps the 60-second budget of ADR-0085 and gives 125 seconds at least 280', () => {
    expect(requiredStopGraceMs(60_000)).toBe(150_000);
    expect(requiredStopGraceMs(125_000)).toBe(280_000);
  });

  it('takes the largest timeout from the operation catalog and the timed public routes', () => {
    const timeouts = [
      ...Object.values(OPERATION_CATALOG).map(({ timeoutMs }) => timeoutMs),
      ...Object.values(PUBLIC_ROUTES).flatMap((route) =>
        'timeoutMs' in route ? [route.timeoutMs] : [],
      ),
    ];
    expect(largestRequestTimeoutMs()).toBe(Math.max(...timeouts));
  });

  it('is covered by the production stop_grace_period', () => {
    expect(composeStopGraceMs()).toBeGreaterThanOrEqual(
      requiredStopGraceMs(largestRequestTimeoutMs()),
    );
  });

  it('is covered for the 125-second Writing /v2 timeout before that route exists', () => {
    expect(composeStopGraceMs()).toBeGreaterThanOrEqual(
      requiredStopGraceMs(125_000),
    );
  });
});
