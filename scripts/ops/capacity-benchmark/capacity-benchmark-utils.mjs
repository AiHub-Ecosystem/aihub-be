export const K6_GRACEFUL_STOP_SECONDS = 65;

/** @typedef {'writing_task1' | 'writing_task2' | 'speaking_multipart' | 'speaking_json'} GradingRouteName */
/** @typedef {'login' | 'refresh' | 'web_session_exchange'} AuthRouteName */
/** @typedef {GradingRouteName | AuthRouteName} BenchmarkRouteName */
/** @typedef {BenchmarkRouteName | 'mixed_grading' | 'auth_and_grading'} BenchmarkWorkload */
/** @type {Record<GradingRouteName, number>} */
export const gradingRouteDeadlinesMs = {
  writing_task1: 60_000,
  writing_task2: 60_000,
  speaking_multipart: 60_000,
  speaking_json: 30_000,
};
/** @typedef {{p50: number | null, p95: number | null, p99: number | null}} Percentiles */
/** @typedef {{count: number, p50: number | null, p95: number | null, p99: number | null}} PathPercentiles */
/** @typedef {{admissionMs: PathPercentiles, completionMs: PathPercentiles}} PathTimings */
/** @typedef {{count: number, status: 'sufficient' | 'inconclusive' | 'not_applicable'}} SampleAdequacy */
/** @typedef {{count: number, requestsPerSecond: number, deadlineMs: number}} RouteGoodput */
/** @typedef {{count: number, failures: number, missedSamples: number, latencyMs: Percentiles}} ProbeResult */
/** @typedef {{count: number, p50Ms: number | null, p95Ms: number | null, p99Ms: number | null, errorCount: number, acceptedLatencyMs: Percentiles, goodput?: RouteGoodput, goodputBySecond?: number[], timingsByPath?: Record<string, PathTimings>}} BenchmarkRoute */
/** @typedef {{workload: string, label: string, offeredRateRps: number, holdDuration: string, completedRequests: number, routes: Record<string, BenchmarkRoute>, probes: {health: ProbeResult, readiness: ProbeResult}, isOverload: boolean, isRecovery: boolean, sampleAdequacy?: {routes?: Record<string, SampleAdequacy>, paths?: Record<string, Record<string, SampleAdequacy>>}}} BenchmarkRun */
/** @typedef {{benchmark: {repetition: number, runtimeCommit: string, runnerDescription: string | null, host: {logicalCpuCount: number, totalMemoryBytes: number}, configuration: {stageRatesRps: number[], minimumGradingSamples: number}, redis: {configuredRoundTripLatencyMs: number}, downstreamStub: {latencyMs: number, errorRate: number}}, runs: BenchmarkRun[]}} BenchmarkReport */
/** @typedef {{min: number | null, median: number | null, max: number | null}} NumericSpread */
/** @typedef {{samples: Array<{repetition: number, count: number, status: string, admissionP50Ms: number | null, admissionP99Ms: number | null, completionP50Ms: number | null, completionP99Ms: number | null}>, admissionP50Ms: NumericSpread | null, admissionP99Ms: NumericSpread | null, completionP50Ms: NumericSpread | null, completionP99Ms: NumericSpread | null, sampleVerdict: 'sufficient' | 'inconclusive'}} RepetitionPathSummary */
/** @typedef {{samples: Array<{errorCount: number}>, acceptedP99Ms: NumericSpread | null, p50Ms: NumericSpread | null, p95Ms: NumericSpread | null, p99Ms: NumericSpread | null, sampleVerdict: string}} RepetitionRouteSummary */

/** @param {number} durationSeconds */
export function k6ProcessTimeoutMs(durationSeconds) {
  return (durationSeconds + K6_GRACEFUL_STOP_SECONDS + 30) * 1000;
}

/** @param {BenchmarkRun[]} runs @param {BenchmarkRouteName[]} routeNames @param {number | Record<string, number>} deadlineMs @param {number} [minimumSamples] */
export function highestPassingRate(
  runs,
  routeNames,
  deadlineMs,
  minimumSamples = 1,
) {
  return runs
    .filter(
      (run) =>
        hasCompleteLoadDelivery(run) &&
        hasMinimumRouteSamples(run, routeNames, minimumSamples) &&
        routeNames.every((name) => {
          const route = run.routes[name];
          return (
            route !== undefined &&
            route.count > 0 &&
            route.p99Ms !== null &&
            route.p99Ms <=
              (typeof deadlineMs === 'number'
                ? deadlineMs
                : deadlineMs[name]) &&
            route.errorCount === 0
          );
        }),
    )
    .reduce((highest, run) => Math.max(highest, run.offeredRateRps), 0);
}

/** @type {GradingRouteName[]} */
const gradingRoutes = [
  'writing_task1',
  'writing_task2',
  'speaking_multipart',
  'speaking_json',
];

/** @type {Record<GradingRouteName, string[]>} */
const gradedPathPairs = {
  writing_task1: [
    'declared_id:keyed_writing',
    'declared_id:none',
    'signed_assertion:keyed_writing',
    'signed_assertion:none',
  ],
  writing_task2: [
    'declared_id:keyed_writing',
    'declared_id:none',
    'signed_assertion:keyed_writing',
    'signed_assertion:none',
  ],
  speaking_multipart: ['declared_id:none', 'signed_assertion:none'],
  speaking_json: ['declared_id:none', 'signed_assertion:none'],
};

/** @param {Pick<BenchmarkRun, 'routes'>} run @param {BenchmarkRouteName[]} routeNames @param {number} minimumSamples */
export function hasMinimumRouteSamples(run, routeNames, minimumSamples) {
  return (
    Number.isSafeInteger(minimumSamples) &&
    minimumSamples > 0 &&
    routeNames.every(
      (name) =>
        Number.isSafeInteger(run.routes[name]?.count) &&
        run.routes[name].count >= minimumSamples,
    )
  );
}

/** @param {Record<string, {admissionMs: number[], completionMs: number[]}>} paths @returns {Record<string, PathTimings>} */
export function summarizeGradedPathTimings(paths) {
  /** @param {number[]} values */
  const summarize = (values) => {
    if (values.length === 0) {
      return { count: 0, p50: null, p95: null, p99: null };
    }
    /** @type {number[]} */
    const ordered = [...values].sort((left, right) => left - right);
    /** @param {number} fraction */
    const at = (fraction) => ordered[Math.ceil(fraction * ordered.length) - 1];
    return {
      count: ordered.length,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
    };
  };
  return Object.fromEntries(
    Object.entries(paths).map(
      ([path, timing]) =>
        /** @type {const} */ ([
          path,
          {
            admissionMs: summarize(timing.admissionMs),
            completionMs: summarize(timing.completionMs),
          },
        ]),
    ),
  );
}

/** @param {GradingRouteName} route @param {Record<string, PathTimings>} timings @param {number} minimumSamples @returns {Record<string, SampleAdequacy>} */
export function gradedPathSampleAdequacy(route, timings, minimumSamples) {
  return Object.fromEntries(
    gradedPathPairs[route].map((path) => {
      const count = timings[path]?.completionMs?.count ?? 0;
      return /** @type {const} */ ([
        path,
        {
          count,
          status: count >= minimumSamples ? 'sufficient' : 'inconclusive',
        },
      ]);
    }),
  );
}

/** @param {BenchmarkWorkload} workload @param {number} offeredRateRps @param {number} minimumSamples @param {number} minimumHoldSeconds */
export function minimumGradingHoldSeconds(
  workload,
  offeredRateRps,
  minimumSamples,
  minimumHoldSeconds,
) {
  if (
    !Number.isSafeInteger(offeredRateRps) ||
    offeredRateRps < 1 ||
    !Number.isSafeInteger(minimumSamples) ||
    minimumSamples < 1 ||
    !Number.isSafeInteger(minimumHoldSeconds) ||
    minimumHoldSeconds < 1
  ) {
    throw new Error('invalid benchmark sample-duration settings');
  }

  let lowestRouteShare;
  if (gradingRoutes.includes(workload)) {
    lowestRouteShare = 1;
  } else if (workload === 'mixed_grading') {
    lowestRouteShare = 1 / gradingRoutes.length;
  } else if (workload === 'auth_and_grading') {
    const shares = gradingRoutes.map(
      (route) =>
        authAndGradingWorkload.filter((item) => item === route).length /
        authAndGradingWorkload.length,
    );
    lowestRouteShare = Math.min(...shares);
  } else {
    return minimumHoldSeconds;
  }

  return Math.max(
    minimumHoldSeconds,
    Math.ceil(minimumSamples / (offeredRateRps * lowestRouteShare)),
  );
}

// Repetitions run on separate VMs of the same runner shape, whose usable
// memory differs by a few MiB; compare the shape, not the exact byte count.
/** @param {BenchmarkReport} report */
const memoryGiB = (report) =>
  Math.round((report.benchmark.host.totalMemoryBytes ?? 0) / 1024 ** 3);

/** @param {BenchmarkReport[]} reports @param {number} expectedRepetitions */
export function summarizeRepetitions(reports, expectedRepetitions) {
  if (
    !Array.isArray(reports) ||
    !Number.isSafeInteger(expectedRepetitions) ||
    expectedRepetitions < 1 ||
    reports.length !== expectedRepetitions
  ) {
    throw new Error('benchmark repetitions are incomplete');
  }
  const sortedReports = [...reports].sort(
    (left, right) => left.benchmark.repetition - right.benchmark.repetition,
  );
  const repetitions = sortedReports.map(
    (report) => report.benchmark.repetition,
  );
  const firstReport = sortedReports[0];
  if (firstReport === undefined) {
    throw new Error('benchmark repetitions are incomplete');
  }
  if (
    new Set(repetitions).size !== expectedRepetitions ||
    repetitions.some((repetition, index) => repetition !== index + 1) ||
    sortedReports.some(
      (report) =>
        report.benchmark.runtimeCommit !==
          firstReport.benchmark.runtimeCommit ||
        report.benchmark.runnerDescription !==
          firstReport.benchmark.runnerDescription ||
        report.benchmark.host.logicalCpuCount !==
          firstReport.benchmark.host.logicalCpuCount ||
        memoryGiB(report) !== memoryGiB(firstReport) ||
        JSON.stringify(report.benchmark.configuration.stageRatesRps) !==
          JSON.stringify(firstReport.benchmark.configuration.stageRatesRps) ||
        report.benchmark.configuration.minimumGradingSamples !==
          firstReport.benchmark.configuration.minimumGradingSamples ||
        report.benchmark.redis.configuredRoundTripLatencyMs !==
          firstReport.benchmark.redis.configuredRoundTripLatencyMs ||
        report.benchmark.downstreamStub.latencyMs !==
          firstReport.benchmark.downstreamStub.latencyMs ||
        report.benchmark.downstreamStub.errorRate !==
          firstReport.benchmark.downstreamStub.errorRate,
    )
  ) {
    throw new Error('benchmark repetitions must be complete and comparable');
  }

  /** @type {Map<string, Array<{repetition: number, run: BenchmarkRun}>>} */
  const stages = new Map();
  for (const report of sortedReports) {
    for (const run of report.runs) {
      const stage = stages.get(run.label) ?? [];
      stage.push({ repetition: report.benchmark.repetition, run });
      stages.set(run.label, stage);
    }
  }

  /** @type {Map<BenchmarkRun, Record<string, {overloadChangePercent?: number, timeToBaselineSeconds?: number | null}>>} */
  const recoveryComparisons = new Map();
  for (const report of sortedReports) {
    const recovery = report.runs.find((run) => run.isRecovery);
    if (recovery === undefined) continue;
    const baseline = report.runs.find(
      (run) =>
        run.workload === recovery.workload &&
        !run.isOverload &&
        !run.isRecovery &&
        run.offeredRateRps === recovery.offeredRateRps,
    );
    const overload = report.runs.find((run) => run.isOverload);
    if (baseline === undefined) continue;
    for (const name of Object.keys(baseline.routes)) {
      const baselineRps = baseline.routes[name]?.goodput?.requestsPerSecond;
      const overloadRps = overload?.routes[name]?.goodput?.requestsPerSecond;
      if (
        overload !== undefined &&
        baselineRps !== undefined &&
        baselineRps > 0 &&
        overloadRps !== undefined
      ) {
        const values = recoveryComparisons.get(overload) ?? {};
        values[name] = {
          ...values[name],
          overloadChangePercent:
            Math.round(((overloadRps - baselineRps) / baselineRps) * 10_000) /
            100,
        };
        recoveryComparisons.set(overload, values);
      }
      const recoveryRoute = recovery.routes[name];
      if (recoveryRoute?.goodputBySecond !== undefined) {
        const recoveryValues = recoveryComparisons.get(recovery) ?? {};
        recoveryValues[name] = {
          ...recoveryValues[name],
          timeToBaselineSeconds: firstGoodputBaselineSecond(
            baselineRps ?? null,
            recoveryRoute.goodputBySecond,
          ),
        };
        recoveryComparisons.set(recovery, recoveryValues);
      }
    }
  }

  return {
    runtimeCommit: firstReport.benchmark.runtimeCommit,
    repetitionCount: expectedRepetitions,
    runnerDescription: firstReport.benchmark.runnerDescription,
    host: firstReport.benchmark.host,
    stageRatesRps: firstReport.benchmark.configuration.stageRatesRps,
    minimumGradingSamples:
      firstReport.benchmark.configuration.minimumGradingSamples,
    stages: [...stages.entries()].map(([label, samples]) => {
      const routeNames = [
        ...new Set(samples.flatMap(({ run }) => Object.keys(run.routes))),
      ];
      const routes = Object.fromEntries(
        routeNames.map((name) => {
          const routeSamples = samples
            .filter(({ run }) => run.routes[name] !== undefined)
            .map(({ repetition, run }) => ({
              repetition,
              run,
              route: run.routes[name],
              adequacy: run.sampleAdequacy?.routes?.[name],
            }));
          const adequacy = routeSamples.map(
            ({ adequacy: value }) => value?.status,
          );
          const sampleVerdict = adequacy.every(
            (status) => status === 'not_applicable',
          )
            ? 'not_applicable'
            : routeSamples.length === expectedRepetitions &&
                adequacy.every((status) => status === 'sufficient')
              ? 'sufficient'
              : 'inconclusive';
          return /** @type {const} */ ([
            name,
            {
              samples: routeSamples.map(({ repetition, route }) => ({
                repetition,
                count: route.count,
                errorCount: route.errorCount,
                goodputCount: route.goodput?.count ?? null,
                goodputRps: route.goodput?.requestsPerSecond ?? null,
              })),
              goodputRps: numericSpread(
                routeSamples.map(
                  ({ route }) => route.goodput?.requestsPerSecond ?? null,
                ),
              ),
              overloadChangePercent: numericSpread(
                routeSamples.map(
                  ({ run }) =>
                    recoveryComparisons.get(run)?.[name]
                      ?.overloadChangePercent ?? null,
                ),
              ),
              timeToBaselineSeconds: numericSpread(
                routeSamples.map(
                  ({ run }) =>
                    recoveryComparisons.get(run)?.[name]
                      ?.timeToBaselineSeconds ?? null,
                ),
              ),
              acceptedP99Ms: numericSpread(
                routeSamples.map(({ route }) => route.acceptedLatencyMs?.p99),
              ),
              p50Ms: numericSpread(
                routeSamples.map(({ route }) => route.p50Ms),
              ),
              p95Ms: numericSpread(
                routeSamples.map(({ route }) => route.p95Ms),
              ),
              p99Ms: numericSpread(
                routeSamples.map(({ route }) => route.p99Ms),
              ),
              sampleVerdict,
            },
          ]);
        }),
      );
      const paths = Object.fromEntries(
        routeNames.filter(isGradingRouteName).map(
          (name) =>
            /** @type {const} */ ([
              name,
              Object.fromEntries(
                gradedPathPairs[name].map((path) => {
                  const pathSamples = samples.map(({ repetition, run }) => {
                    const adequacy = run.sampleAdequacy?.paths?.[name]?.[path];
                    const timing = run.routes[name]?.timingsByPath?.[path];
                    return {
                      repetition,
                      count: adequacy?.count ?? 0,
                      status: adequacy?.status ?? 'inconclusive',
                      admissionP50Ms: timing?.admissionMs?.p50 ?? null,
                      admissionP99Ms: timing?.admissionMs?.p99 ?? null,
                      completionP50Ms: timing?.completionMs?.p50 ?? null,
                      completionP99Ms: timing?.completionMs?.p99 ?? null,
                    };
                  });
                  return /** @type {const} */ ([
                    path,
                    {
                      samples: pathSamples,
                      admissionP50Ms: numericSpread(
                        pathSamples.map((sample) => sample.admissionP50Ms),
                      ),
                      admissionP99Ms: numericSpread(
                        pathSamples.map((sample) => sample.admissionP99Ms),
                      ),
                      completionP50Ms: numericSpread(
                        pathSamples.map((sample) => sample.completionP50Ms),
                      ),
                      completionP99Ms: numericSpread(
                        pathSamples.map((sample) => sample.completionP99Ms),
                      ),
                      sampleVerdict:
                        pathSamples.length === expectedRepetitions &&
                        pathSamples.every(
                          (sample) =>
                            sample.status === 'sufficient' &&
                            sample.count >=
                              firstReport.benchmark.configuration
                                .minimumGradingSamples,
                        )
                          ? 'sufficient'
                          : 'inconclusive',
                    },
                  ]);
                }),
              ),
            ]),
        ),
      );
      const complete = samples.length === expectedRepetitions;
      const sampleAdequate =
        Object.values(routes).every(
          ({ sampleVerdict }) =>
            sampleVerdict === 'sufficient' ||
            sampleVerdict === 'not_applicable',
        ) &&
        Object.values(paths).every((routePaths) =>
          Object.values(routePaths).every(
            ({ sampleVerdict }) => sampleVerdict === 'sufficient',
          ),
        );
      const firstSample = samples[0];
      if (firstSample === undefined) {
        throw new Error('benchmark stage has no samples');
      }
      return {
        label,
        workload: firstSample.run.workload,
        offeredRateRps: firstSample.run.offeredRateRps,
        repetitionCount: samples.length,
        verdict: complete && sampleAdequate ? 'sufficient' : 'inconclusive',
        probes: Object.fromEntries(
          /** @type {const} */ (['health', 'readiness']).map((name) => {
            const probeSamples = samples.map(({ repetition, run }) => ({
              repetition,
              count: run.probes[name].count,
              failures: run.probes[name].failures,
              missedSamples: run.probes[name].missedSamples,
              p95Ms: run.probes[name].latencyMs.p95,
            }));
            return [
              name,
              {
                samples: probeSamples,
                p95Ms: numericSpread(
                  probeSamples.map((sample) => sample.p95Ms),
                ),
              },
            ];
          }),
        ),
        routes,
        paths,
      };
    }),
  };
}

/** @param {Array<number | null>} values @returns {NumericSpread | null} */
function numericSpread(values) {
  const sorted = values
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return {
    min: sorted[0],
    median:
      sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle],
    max: sorted.at(-1),
  };
}

/** @param {string} name @returns {name is GradingRouteName} */
export function isGradingRouteName(name) {
  return Object.hasOwn(gradedPathPairs, name);
}

/** @param {{question: string, topic: string, essay: string, url: string}} fixture */
export function task1PayloadFromFixture(fixture) {
  return {
    question: fixture.question,
    chart_type: fixture.topic,
    essay: fixture.essay,
    image_url: fixture.url,
  };
}

/** @type {BenchmarkRouteName[]} */
export const authAndGradingWorkload = [
  'writing_task1',
  'writing_task2',
  'speaking_multipart',
  'login',
  'speaking_json',
  'writing_task1',
  'writing_task2',
  'refresh',
  'speaking_multipart',
  'speaking_json',
  'writing_task1',
  'web_session_exchange',
  'writing_task2',
  'speaking_multipart',
  'speaking_json',
  'login',
];

/** @param {Pick<BenchmarkRun, 'holdDuration' | 'offeredRateRps' | 'completedRequests'>} run */
export function hasCompleteLoadDelivery(run) {
  const duration = /^(\d+)s$/.exec(run.holdDuration);
  const durationSeconds = Number(duration?.[1]);
  const expectedRequests = run.offeredRateRps * durationSeconds;
  return (
    Number.isSafeInteger(durationSeconds) &&
    durationSeconds > 0 &&
    Number.isSafeInteger(run.offeredRateRps) &&
    run.offeredRateRps > 0 &&
    Number.isSafeInteger(expectedRequests) &&
    Number.isSafeInteger(run.completedRequests) &&
    run.completedRequests >= expectedRequests
  );
}

/** @param {number} maxVUs @param {number} userCount */
export function hasOneUserPerVu(maxVUs, userCount) {
  return (
    Number.isSafeInteger(maxVUs) &&
    maxVUs > 0 &&
    Number.isSafeInteger(userCount) &&
    userCount >= maxVUs
  );
}

/** @param {Array<{durationMs: number}>} jobs @param {number} maxDurationMs */
export function contentionJobsFitLoadWindow(jobs, maxDurationMs) {
  return (
    jobs.length > 0 &&
    Number.isSafeInteger(maxDurationMs) &&
    maxDurationMs >= 0 &&
    jobs.every(
      (job) =>
        Number.isSafeInteger(job.durationMs) &&
        job.durationMs >= 0 &&
        job.durationMs <= maxDurationMs,
    )
  );
}

/** @param {string} previousTail @param {string} chunk @param {string} marker */
export function appendStreamingMarkerChunk(previousTail, chunk, marker) {
  const combined = previousTail + chunk;
  return {
    found: combined.includes(marker),
    tail: combined.slice(-marker.length),
  };
}

/** @param {number[]} stageRates @param {number} passingRate */
export function overloadRate(stageRates, passingRate) {
  if (passingRate <= 0) {
    const highestStage = stageRates.at(-1);
    if (highestStage === undefined)
      throw new Error('no rate stages configured');
    return Math.ceil(highestStage * 1.5);
  }
  const nextStage = stageRates.find((rate) => rate > passingRate);
  if (nextStage !== undefined) return nextStage;
  const highestStage = stageRates.at(-1);
  if (highestStage === undefined) throw new Error('no rate stages configured');
  return Math.ceil(Math.max(highestStage, passingRate) * 1.5);
}

/** @param {Record<string, {values?: Record<string, unknown>} | undefined>} metrics @param {string} name @param {string} [statistic] */
export function metricValue(metrics, name, statistic = 'max') {
  const values = metrics[name]?.values;
  const value = values?.[statistic];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @param {string} text @param {string} prefix @returns {unknown} */
export function jsonAfterPrefix(text, prefix) {
  const line = text.split(/\r?\n/).find((item) => item.includes(prefix));
  if (line === undefined) return undefined;
  const payload = line.slice(line.indexOf(prefix) + prefix.length).trim();
  const end = payload.lastIndexOf('}');
  if (end < 0) return undefined;
  const serialized = payload.slice(0, end + 1);
  return /** @type {unknown} */ (
    JSON.parse(
      serialized.startsWith('{\\"')
        ? serialized.replace(/\\"/g, '"')
        : serialized,
    )
  );
}

/** @param {Record<string, {values?: Record<string, unknown>} | undefined>} metrics @param {string} prefix */
export function taggedMetricValues(metrics, prefix) {
  return Object.entries(metrics)
    .filter(([name]) => name.startsWith(`${prefix}{`) && name.endsWith('}'))
    .map(([name, metric]) => ({
      labels: Object.fromEntries(
        [
          ...name.slice(prefix.length + 1, -1).matchAll(/([^,:]+):([^,]*)/g),
        ].map((match) => [match[1], match[2]]),
      ),
      values: metric.values ?? {},
    }));
}

/** @param {Record<string, {values?: Record<string, unknown>} | undefined>} metrics @param {GradingRouteName} route @param {number} durationSeconds */
export function goodputCountsBySecond(metrics, route, durationSeconds) {
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1) {
    throw new Error('invalid goodput sample duration');
  }
  const counts = Array.from({ length: durationSeconds }, () => 0);
  for (const sample of taggedMetricValues(
    metrics,
    'benchmark_goodput_by_second',
  )) {
    const second = Number(sample.labels.second);
    const count = sample.values.count;
    if (
      sample.labels.route === route &&
      Number.isSafeInteger(second) &&
      second >= 0 &&
      second < durationSeconds &&
      typeof count === 'number' &&
      Number.isSafeInteger(count) &&
      count > 0
    ) {
      counts[second] += count;
    }
  }
  return counts;
}

/** @param {number | null} baselineRequestsPerSecond @param {number[]} recoveryCountsBySecond */
export function firstGoodputBaselineSecond(
  baselineRequestsPerSecond,
  recoveryCountsBySecond,
) {
  if (
    baselineRequestsPerSecond === null ||
    !Number.isFinite(baselineRequestsPerSecond) ||
    baselineRequestsPerSecond <= 0
  ) {
    return null;
  }
  const second = recoveryCountsBySecond.findIndex(
    (count) => count >= baselineRequestsPerSecond,
  );
  return second < 0 ? null : second + 1;
}

/** @param {string} line @returns {{cpuPercent: number, memoryBytes: number | null}} */
export function parseDockerStats(line) {
  // Streaming `docker stats` redraws the terminal with ANSI escapes around each
  // JSON row even when stdout is a pipe.
  const parsed = /** @type {unknown} */ (
    JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1))
  );
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid Docker stats output');
  }
  const stats = /** @type {Record<string, unknown>} */ (parsed);
  const memory = stats.MemUsage;
  if (memory != null && typeof memory !== 'string') {
    throw new Error('invalid Docker stats output');
  }
  return {
    cpuPercent: parseFloat(String(stats.CPUPerc)),
    memoryBytes: parseBytes(memory?.split('/')[0]?.trim() ?? ''),
  };
}

/** @param {string} reference @param {string} output */
export function parseDockerImageIdentity(reference, output) {
  const separator = output.indexOf(' ');
  if (separator < 1) throw new Error('invalid Docker image inspect output');
  const parsedDigests = /** @type {unknown} */ (
    JSON.parse(output.slice(separator + 1))
  );
  if (
    !Array.isArray(parsedDigests) ||
    !parsedDigests.every((digest) => typeof digest === 'string')
  ) {
    throw new Error('invalid Docker image repository digests');
  }
  return {
    reference,
    imageId: output.slice(0, separator),
    repositoryDigests: parsedDigests,
  };
}

/** @param {string} value @returns {number | null} */
function parseBytes(value) {
  const match = value.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|KB|MB|GB)$/i);
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier = {
    B: 1,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
  }[unit];
  return multiplier === undefined ? null : Math.round(amount * multiplier);
}
