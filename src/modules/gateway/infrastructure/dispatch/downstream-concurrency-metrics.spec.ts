import { getMetrics, registry } from '@/common/observability/metrics';
import {
  recordDownstreamLimitDropped,
  setDownstreamConcurrencySource,
} from './downstream-concurrency-metrics';

describe('downstream adaptive concurrency metrics', () => {
  afterEach(() => {
    setDownstreamConcurrencySource(undefined);
    registry.resetMetrics();
  });

  it('exposes the adaptive limit, RTT baseline, average RTT, and drops per origin', async () => {
    setDownstreamConcurrencySource(() => [
      {
        origin: 'https://ai-writing.test',
        limit: 7,
        inFlight: 3,
        rttMinMs: 1_500,
        rttAvgMs: 2_000,
      },
    ]);

    const payload = await getMetrics();
    expect(payload).toContain(
      'aihub_downstream_concurrency_limit{origin="https://ai-writing.test"} 7',
    );
    expect(payload).toContain(
      'aihub_downstream_rtt_min_seconds{origin="https://ai-writing.test"} 1.5',
    );
    expect(payload).toContain(
      'aihub_downstream_rtt_avg_seconds{origin="https://ai-writing.test"} 2',
    );
    for (const name of [
      'aihub_downstream_concurrency_limit',
      'aihub_downstream_rtt_min_seconds',
      'aihub_downstream_rtt_avg_seconds',
      'aihub_downstream_limit_dropped_total',
    ]) {
      expect(payload).toContain(`# HELP ${name} `);
    }
  });

  it('counts refused admissions per origin', async () => {
    recordDownstreamLimitDropped('https://ai-speaking.test');
    recordDownstreamLimitDropped('https://ai-speaking.test');

    expect(await getMetrics()).toContain(
      'aihub_downstream_limit_dropped_total{origin="https://ai-speaking.test"} 2',
    );
  });

  it('drops gauge series when the source is cleared', async () => {
    setDownstreamConcurrencySource(() => [
      {
        origin: 'https://ai-writing.test',
        limit: 7,
        inFlight: 3,
        rttMinMs: 1_500,
        rttAvgMs: 2_000,
      },
    ]);
    await getMetrics();

    setDownstreamConcurrencySource(undefined);

    expect(await getMetrics()).not.toContain(
      'aihub_downstream_concurrency_limit{',
    );
  });
});
