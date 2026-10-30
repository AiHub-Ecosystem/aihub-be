import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { summarizeRepetitions } from './capacity-benchmark-utils.mjs';

/** @typedef {{count: number, requestsPerSecond: number, deadlineMs: number}} RouteGoodput */
/** @typedef {{count: number, failures: number, missedSamples: number, latencyMs: {p50: number | null, p95: number | null, p99: number | null}}} ProbeResult */
/** @typedef {{count: number, errorCount: number, p50Ms: number | null, p95Ms: number | null, p99Ms: number | null, acceptedLatencyMs: {p50: number | null, p95: number | null, p99: number | null}, goodput?: RouteGoodput, goodputBySecond?: number[], timingsByPath?: Record<string, {admissionMs: {count: number, p50: number | null, p95: number | null, p99: number | null}, completionMs: {count: number, p50: number | null, p95: number | null, p99: number | null}}>} BenchmarkRoute */
/** @typedef {{workload: string, label: string, offeredRateRps: number, holdDuration: string, completedRequests: number, routes: Record<string, BenchmarkRoute>, probes: {health: ProbeResult, readiness: ProbeResult}, isOverload: boolean, isRecovery: boolean, sampleAdequacy?: {routes?: Record<string, {count: number, status: 'sufficient' | 'inconclusive' | 'not_applicable'}>, paths?: Record<string, Record<string, {count: number, status: 'sufficient' | 'inconclusive' | 'not_applicable'}>>}}} BenchmarkRun */
/** @typedef {{benchmark: {repetition: number, runtimeCommit: string, runnerDescription: string | null, host: {operatingSystem: string, logicalCpuCount: number, cpuModel: string | null, totalMemoryBytes: number}, configuration: {stageRatesRps: number[], minimumGradingSamples: number}, redis: {configuredRoundTripLatencyMs: number}, downstreamStub: {latencyMs: number, errorRate: number}}, runs: BenchmarkRun[]}} BenchmarkReport */
/** @typedef {NonNullable<ReturnType<typeof summarizeRepetitions>>} RepetitionSummary */

const expectedRepetitions = Number(process.argv[2] ?? 3);
const artifactRoot = path.resolve(
  process.argv[3] ?? 'artifacts/capacity-benchmark',
);
const entries = await readdir(artifactRoot, { withFileTypes: true });
/** @type {BenchmarkReport[]} */
const reports = [];
for (const entry of entries.filter((item) => item.isDirectory())) {
  let contents;
  try {
    const resultPath = path.join(artifactRoot, entry.name, 'results.json');
    contents = await readFile(resultPath, 'utf8');
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
    continue;
  }
  reports.push(parseBenchmarkReport(JSON.parse(contents)));
}

const summary = summarizeRepetitions(reports, expectedRepetitions);
const jsonPath = path.join(artifactRoot, 'repetitions-summary.json');
const markdownPath = path.join(artifactRoot, 'repetitions-summary.md');
const markdown = renderMarkdown(summary);
await Promise.all([
  writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`),
  writeFile(markdownPath, markdown),
]);
process.stdout.write(markdown);

/** @param {RepetitionSummary} result @returns {string} */
function renderMarkdown(result) {
  const host = result.host;
  const lines = [
    '# Capacity benchmark repetitions',
    '',
    `- Commit: \`${result.runtimeCommit}\``,
    `- Runner: ${result.runnerDescription ?? 'not recorded'}`,
    `- Host: ${host.operatingSystem}; ${host.logicalCpuCount} logical CPUs; ${host.cpuModel ?? 'CPU model unavailable'}; ${(host.totalMemoryBytes / 1024 ** 3).toFixed(1)} GiB RAM`,
    `- Stages: ${result.stageRatesRps.join(', ')} RPS`,
    `- Minimum grading samples per route: ${result.minimumGradingSamples}`,
    `- Repetitions: ${result.repetitionCount}`,
    '',
    '| Stage | Offered RPS | Route | Goodput RPS min / median / max | Overload vs passing baseline (%) | Recovery to baseline (s) | Health p95 / failed / missing | Ready p95 / failed / missing | Completed samples by repetition | Errors by repetition | p99 min / median / max (ms) | Accepted p99 min / median / max (ms) | Sample verdict |',
    '| --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  /** @param {{min: number | null, median: number | null, max: number | null} | null} value */
  const spread = (value) =>
    value ? `${value.min} / ${value.median} / ${value.max}` : 'unavailable';
  /** @param {{samples: Array<{repetition: number, p95Ms: number | null, failures: number, missedSamples: number}>}} probe */
  const probeCell = (probe) =>
    probe.samples
      .map(
        ({ repetition, p95Ms, failures, missedSamples }) =>
          `R${repetition}: ${p95Ms === null ? 'n/a' : `${p95Ms}ms`} / ${failures} / ${missedSamples}`,
      )
      .join('<br>');
  for (const stage of result.stages) {
    for (const [routeName, route] of Object.entries(stage.routes)) {
      const counts = route.samples
        .map(({ repetition, count }) => `R${repetition}: ${count}`)
        .join(', ');
      const errors = route.samples
        .map(({ repetition, errorCount }) => `R${repetition}: ${errorCount}`)
        .join(', ');
      lines.push(
        `| ${stage.label} | ${stage.offeredRateRps} | ${routeName} | ${spread(route.goodputRps)} | ${spread(route.overloadChangePercent)} | ${spread(route.timeToBaselineSeconds)} | ${probeCell(stage.probes.health)} | ${probeCell(stage.probes.readiness)} | ${counts} | ${errors} | ${spread(route.p99Ms)} | ${spread(route.acceptedP99Ms)} | ${route.sampleVerdict} |`,
      );
    }
  }

  lines.push(
    '',
    'Goodput counts 2xx grading responses completed within the configured route deadline; its rate is divided by the stage hold duration. Overload change compares each route with the highest passing mixed-grading stage. Recovery is the first observed one-second bucket meeting or exceeding that baseline, so it does not establish sustained recovery. Probe cells show p95 latency, failed requests, and missed scheduled samples per repetition. Each stage verdict is inconclusive if it is missing a repetition or any grading route has fewer than the configured minimum samples. The sample verdict counts every response, so read it with the error column; a route that answers only with errors has enough samples but no capacity. Accepted p99 covers 2xx responses only.',
    '',
  );
  return lines.join('\n');
}

/** @param {unknown} value @returns {BenchmarkReport} */
function parseBenchmarkReport(value) {
  if (
    !isRecord(value) ||
    !isRecord(value.benchmark) ||
    !Array.isArray(value.runs)
  ) {
    throw new Error('capacity benchmark report is invalid');
  }
  const { benchmark } = value;
  if (
    typeof benchmark.repetition !== 'number' ||
    typeof benchmark.runtimeCommit !== 'string' ||
    (benchmark.runnerDescription !== null &&
      typeof benchmark.runnerDescription !== 'string') ||
    !isRecord(benchmark.host) ||
    typeof benchmark.host.operatingSystem !== 'string' ||
    typeof benchmark.host.logicalCpuCount !== 'number' ||
    (benchmark.host.cpuModel !== null &&
      typeof benchmark.host.cpuModel !== 'string') ||
    typeof benchmark.host.totalMemoryBytes !== 'number' ||
    !isRecord(benchmark.configuration) ||
    !isNumberArray(benchmark.configuration.stageRatesRps) ||
    typeof benchmark.configuration.minimumGradingSamples !== 'number' ||
    !isRecord(benchmark.redis) ||
    typeof benchmark.redis.configuredRoundTripLatencyMs !== 'number' ||
    !isRecord(benchmark.downstreamStub) ||
    typeof benchmark.downstreamStub.latencyMs !== 'number' ||
    typeof benchmark.downstreamStub.errorRate !== 'number' ||
    !value.runs.every(isBenchmarkRun)
  ) {
    throw new Error('capacity benchmark report is invalid');
  }
  return /** @type {BenchmarkReport} */ (value);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is number[]} */
function isNumberArray(value) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'number')
  );
}

/** @param {unknown} value @returns {value is BenchmarkRun} */
function isBenchmarkRun(value) {
  if (
    !isRecord(value) ||
    typeof value.workload !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.offeredRateRps !== 'number' ||
    typeof value.holdDuration !== 'string' ||
    typeof value.completedRequests !== 'number' ||
    !isRecord(value.routes) ||
    !Object.values(value.routes).every(isBenchmarkRoute) ||
    !isRecord(value.probes) ||
    !isProbeResult(value.probes.health) ||
    !isProbeResult(value.probes.readiness) ||
    typeof value.isOverload !== 'boolean' ||
    typeof value.isRecovery !== 'boolean'
  ) {
    return false;
  }
  if (value.sampleAdequacy === undefined) return true;
  if (!isRecord(value.sampleAdequacy)) return false;
  const { routes, paths } = value.sampleAdequacy;
  return (
    (routes === undefined || isAdequacyRecord(routes)) &&
    (paths === undefined || isPathAdequacyRecord(paths))
  );
}

/** @param {unknown} value @returns {value is BenchmarkRoute} */
function isBenchmarkRoute(value) {
  if (
    !isRecord(value) ||
    typeof value.count !== 'number' ||
    typeof value.errorCount !== 'number' ||
    !isNullableNumber(value.p50Ms) ||
    !isNullableNumber(value.p95Ms) ||
    !isNullableNumber(value.p99Ms)
  ) {
    return false;
  }
  if (
    !isRecord(value.acceptedLatencyMs) ||
    !isNullableNumber(value.acceptedLatencyMs.p50) ||
    !isNullableNumber(value.acceptedLatencyMs.p95) ||
    !isNullableNumber(value.acceptedLatencyMs.p99)
  ) {
    return false;
  }
  return (
    (value.timingsByPath === undefined ||
      isPathTimingsRecord(value.timingsByPath)) &&
    (value.goodput === undefined || isGoodput(value.goodput)) &&
    (value.goodputBySecond === undefined ||
      isNumberArray(value.goodputBySecond))
  );
}

/** @param {unknown} value @returns {value is RouteGoodput} */
function isGoodput(value) {
  return (
    isRecord(value) &&
    typeof value.count === 'number' &&
    typeof value.requestsPerSecond === 'number' &&
    typeof value.deadlineMs === 'number'
  );
}

/** @param {unknown} value @returns {value is ProbeResult} */
function isProbeResult(value) {
  return (
    isRecord(value) &&
    typeof value.count === 'number' &&
    typeof value.failures === 'number' &&
    typeof value.missedSamples === 'number' &&
    isRecord(value.latencyMs) &&
    isNullableNumber(value.latencyMs.p50) &&
    isNullableNumber(value.latencyMs.p95) &&
    isNullableNumber(value.latencyMs.p99)
  );
}

/** @param {unknown} value @returns {value is number | null} */
function isNullableNumber(value) {
  return value === null || typeof value === 'number';
}

/** @param {unknown} value @returns {boolean} */
function isAdequacyRecord(value) {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (item) =>
        isRecord(item) &&
        typeof item.count === 'number' &&
        typeof item.status === 'string',
    )
  );
}

/** @param {unknown} value @returns {boolean} */
function isPathAdequacyRecord(value) {
  return isRecord(value) && Object.values(value).every(isAdequacyRecord);
}

/** @param {unknown} value @returns {boolean} */
function isPathTimingsRecord(value) {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (timing) =>
        isRecord(timing) &&
        isTimingPercentiles(timing.admissionMs) &&
        isTimingPercentiles(timing.completionMs),
    )
  );
}

/** @param {unknown} value @returns {boolean} */
function isTimingPercentiles(value) {
  return (
    isRecord(value) &&
    typeof value.count === 'number' &&
    isNullableNumber(value.p50) &&
    isNullableNumber(value.p95) &&
    isNullableNumber(value.p99)
  );
}
