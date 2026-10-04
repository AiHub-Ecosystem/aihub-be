import { METRICS_ROUTE_PATH, getMetrics } from './metrics';
import { recordCompletedRequest } from './metrics';

const GRADE = 'writing.task1.grade';

/**
 * The value of one sample, or undefined when the series is absent. Prometheus
 * exposition orders labels by name, so the selector is built the same way
 * rather than pattern-matched.
 */
async function sample(
  name: string,
  labels: Record<string, string> = {},
): Promise<string | undefined> {
  const selector = `${name}{${Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',')}}`;

  const line = (await getMetrics())
    .split('\n')
    .find((candidate) => candidate.trimStart().startsWith(`${selector} `));

  return line?.trimStart().slice(selector.length + 1);
}

describe('request lifecycle metrics', () => {
  it('counts a completed request with its status and outcome', async () => {
    recordCompletedRequest({
      operation: GRADE,
      statusCode: 200,
      outcome: 'success',
      totalMs: 840,
      downstreamMs: 810,
      tokens: 1130,
      meteringStatus: 'complete',
    });

    expect(
      await sample('aihub_requests_total', {
        operation: GRADE,
        status: '200',
        outcome: 'success',
      }),
    ).toBeDefined();
    expect(await sample('aihub_tokens_total', { operation: GRADE })).toBe(
      '1130',
    );
  });

  it('records a failed request the same way as a successful one', async () => {
    recordCompletedRequest({
      operation: GRADE,
      statusCode: 503,
      outcome: 'downstream_error',
      totalMs: 5000,
    });

    expect(
      await sample('aihub_requests_total', {
        operation: GRADE,
        status: '503',
        outcome: 'downstream_error',
      }),
    ).toBeDefined();
  });

  it('counts a record whose metering status is missing_usage', async () => {
    recordCompletedRequest({
      operation: GRADE,
      statusCode: 200,
      outcome: 'success',
      meteringStatus: 'missing_usage',
    });

    expect(
      await sample('aihub_metering_incomplete_total', { operation: GRADE }),
    ).toBeDefined();
  });

  it('does not count a record whose metering status is complete', async () => {
    recordCompletedRequest({
      operation: 'speaking.grading',
      statusCode: 200,
      outcome: 'success',
      meteringStatus: 'complete',
    });

    expect(
      await sample('aihub_metering_incomplete_total', {
        operation: 'speaking.grading',
      }),
    ).toBeUndefined();
  });

  it('reports duration in seconds rather than milliseconds', async () => {
    recordCompletedRequest({
      operation: 'speaking.grading',
      statusCode: 200,
      outcome: 'success',
      totalMs: 2000,
      downstreamMs: 1500,
    });

    const total = Number(
      await sample('aihub_request_duration_seconds_sum', {
        operation: 'speaking.grading',
      }),
    );
    const downstream = Number(
      await sample('aihub_downstream_duration_seconds_sum', {
        operation: 'speaking.grading',
      }),
    );

    // Summed observations are seconds: 2000ms must never read as 2000.
    expect(total).toBeGreaterThan(1);
    expect(total).toBeLessThan(100);
    expect(downstream).toBeGreaterThan(1);
    expect(downstream).toBeLessThan(100);
  });

  it('never emits a series carrying an organization identifier', async () => {
    recordCompletedRequest({
      operation: GRADE,
      statusCode: 200,
      outcome: 'success',
      tokens: 10,
    });

    const payload = await getMetrics();
    expect(payload).not.toContain('org_id');
    expect(payload).not.toContain('organization');
  });

  it('exposes the scrape path as /metrics', () => {
    expect(METRICS_ROUTE_PATH).toBe('/metrics');
  });

  it('reports a non-finite duration as a zero-length observation', async () => {
    recordCompletedRequest({
      operation: GRADE,
      statusCode: 200,
      outcome: 'success',
      totalMs: Number.NaN,
      downstreamMs: -5,
    });

    // Must not throw, and must not produce NaN in the exposition payload.
    expect(await getMetrics()).not.toContain('NaN');
  });
});
