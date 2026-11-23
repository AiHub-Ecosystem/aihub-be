import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';

// Shutdown budget: ADR-0085 as amended on 2026-11-01 (the amendment follows
// ADR-0143, which routes Writing /v2 grading at 125 s). `docker-compose.production.yml`
// `stop_grace_period` must be at least requiredStopGraceMs(largest timeout):
//   HTTP drain   = the largest request timeout
//   background   = that timeout + 15s (idempotent work runs on after its response
//                  deadline, then the final writes and an email outbox pass)
//   telemetry    = 5s flush
//   margin       = 10s
// shutdown-budget.spec.ts fails when the compose value falls short.
// Slack past the timeout for the final writes after late work ends.
const BACKGROUND_SLACK_MS = 15_000;
const TELEMETRY_FLUSH_MS = 5_000;
const SHUTDOWN_MARGIN_MS = 10_000;

export function backgroundDrainMs(timeoutMs: number): number {
  return timeoutMs + BACKGROUND_SLACK_MS;
}

export function requiredStopGraceMs(timeoutMs: number): number {
  return (
    timeoutMs +
    backgroundDrainMs(timeoutMs) +
    TELEMETRY_FLUSH_MS +
    SHUTDOWN_MARGIN_MS
  );
}

export function largestRequestTimeoutMs(): number {
  const routeTimeouts = Object.values(PUBLIC_ROUTES).flatMap((route) =>
    'timeoutMs' in route ? [route.timeoutMs] : [],
  );
  return Math.max(
    ...Object.values(OPERATION_CATALOG).map(({ timeoutMs }) => timeoutMs),
    ...routeTimeouts,
  );
}
