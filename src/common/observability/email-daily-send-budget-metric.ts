import { Gauge, type Registry } from '@prometheus-io/client';

export interface EmailDailySendBudgetSample {
  readonly used: number;
  readonly limit: number;
}

type Source = () => Promise<EmailDailySendBudgetSample>;

export function registerEmailDailySendBudgetMetric(
  registry: Registry,
): (source: Source | undefined) => void {
  let source: Source | undefined;
  let pending: Promise<void> | undefined;
  const gauge = new Gauge({
    name: 'aihub_email_daily_send_budget',
    help: 'Current UTC-day Resend email reservations and configured budget.',
    labelNames: ['measurement'],
    registers: [registry],
    collect() {
      if (source === undefined) return;
      pending ??= (async () => {
        try {
          const sample = await source?.();
          if (sample === undefined) return;
          this.reset();
          this.set({ measurement: 'used' }, sample.used);
          this.set({ measurement: 'limit' }, sample.limit);
        } catch {
          this.reset();
        } finally {
          pending = undefined;
        }
      })();
      return pending;
    },
  });

  return (nextSource) => {
    source = nextSource;
    if (source === undefined) gauge.reset();
  };
}
