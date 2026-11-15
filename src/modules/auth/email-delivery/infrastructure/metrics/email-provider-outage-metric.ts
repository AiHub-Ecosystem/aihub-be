import { Gauge, type Registry } from '@prometheus-io/client';

type Source = () => Promise<number>;

export function registerEmailProviderOutageMetric(
  registry: Registry,
): (source: Source | undefined) => void {
  let source: Source | undefined;
  let pending: Promise<void> | undefined;
  const gauge = new Gauge({
    name: 'aihub_email_provider_outage_duration_seconds',
    help: 'Duration of the shared Resend provider outage circuit.',
    registers: [registry],
    collect() {
      pending ??= (async () => {
        try {
          const durationMs = await source?.();
          this.set(
            durationMs !== undefined &&
              Number.isFinite(durationMs) &&
              durationMs >= 0
              ? durationMs / 1_000
              : 0,
          );
        } catch {
          this.set(0);
        } finally {
          pending = undefined;
        }
      })();
      return pending;
    },
  });

  return (nextSource) => {
    source = nextSource;
    if (source === undefined) gauge.set(0);
  };
}
