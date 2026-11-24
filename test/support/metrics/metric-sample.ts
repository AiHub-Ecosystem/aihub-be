import { getMetrics } from '@/common/observability/metrics/metrics';

/**
 * The value of one sample, or undefined when the series is absent. Prometheus
 * exposition orders labels by name, so the selector is built the same way
 * rather than pattern-matched.
 */
export async function sample(
  name: string,
  labels: Record<string, string> = {},
): Promise<string | undefined> {
  const labelSelector = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',');
  const selector =
    labelSelector.length === 0 ? name : `${name}{${labelSelector}}`;

  const line = (await getMetrics())
    .split('\n')
    .find((candidate) => candidate.trimStart().startsWith(`${selector} `));

  return line?.trimStart().slice(selector.length + 1);
}
