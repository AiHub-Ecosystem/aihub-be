import { RedisHealthReporter } from './redis-health-reporter';

class FakeLogger {
  readonly warnings: Record<string, unknown>[] = [];
  readonly logs: Record<string, unknown>[] = [];

  warn(fields: Record<string, unknown>): void {
    this.warnings.push(fields);
  }

  log(fields: Record<string, unknown>): void {
    this.logs.push(fields);
  }
}

describe('RedisHealthReporter', () => {
  const metricsText = async (): Promise<string> => {
    const metrics = await import('@/common/observability/metrics');
    return metrics.getMetrics();
  };

  it('warns once on the healthy to degraded transition and recovers once', () => {
    const logger = new FakeLogger();
    const reporter = new RedisHealthReporter(
      'quota',
      'quota counter',
      logger,
      'quota admission will use its configured outage policy',
    );

    reporter.reportDegraded();
    reporter.reportDegraded();
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toMatchObject({
      event: 'redis_degraded',
      seam: 'quota',
      subject: 'quota counter',
      policy: 'quota admission will use its configured outage policy',
    });

    reporter.reportRecovered();
    reporter.reportRecovered();
    expect(logger.logs).toHaveLength(1);
    expect(logger.logs[0]).toEqual({
      event: 'redis_recovered',
      seam: 'quota',
      subject: 'quota counter',
    });

    reporter.reportDegraded();
    expect(logger.warnings).toHaveLength(2);
    expect(logger.logs).toHaveLength(1);
  });

  it('counts the unavailable metric on every failed command, not once per transition', async () => {
    const seam = 'rate_limit';
    const reporter = new RedisHealthReporter(
      seam,
      'rate limiter',
      new FakeLogger(),
      'falling back to a process-local ceiling until it recovers',
    );

    const before = await metricsText();
    const readCount = (text: string): string | undefined =>
      text
        .split('\n')
        .find((line) =>
          line.startsWith(`aihub_redis_unavailable_total{seam="${seam}"}`),
        );

    reporter.reportDegraded();
    reporter.reportDegraded();

    const after = await metricsText();
    const beforeValue = Number(readCount(before)?.split('} ')[1] ?? '0');
    const afterValue = Number(readCount(after)?.split('} ')[1] ?? '0');
    expect(afterValue).toBe(beforeValue + 2);
  });

  it('includes the failure reason in the structured degraded event', () => {
    const logger = new FakeLogger();
    const reporter = new RedisHealthReporter(
      'concurrency',
      'concurrency limiter',
      logger,
      'refusing requests until it recovers',
    );

    reporter.reportDegraded(new Error('redis down'));
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toMatchObject({
      event: 'redis_degraded',
      seam: 'concurrency',
      reason: 'redis down',
      policy: 'refusing requests until it recovers',
    });

    const stringReporter = new RedisHealthReporter(
      'concurrency',
      'concurrency limiter',
      logger,
      'refusing requests until it recovers',
    );
    stringReporter.reportDegraded('timeout');
    expect(logger.warnings[1]).toMatchObject({ reason: 'timeout' });
  });
});
