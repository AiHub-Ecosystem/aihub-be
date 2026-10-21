export const K6_GRACEFUL_STOP_SECONDS = 65;

export function k6ProcessTimeoutMs(durationSeconds) {
  return (durationSeconds + K6_GRACEFUL_STOP_SECONDS + 30) * 1000;
}

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

const gradingRoutes = [
  'writing_task1',
  'writing_task2',
  'speaking_multipart',
  'speaking_json',
];

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

export function summarizeGradedPathTimings(paths) {
  const summarize = (values) => {
    if (values.length === 0) {
      return { count: 0, p50: null, p95: null, p99: null };
    }
    const ordered = [...values].sort((left, right) => left - right);
    const at = (fraction) => ordered[Math.ceil(fraction * ordered.length) - 1];
    return {
      count: ordered.length,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
    };
  };
  return Object.fromEntries(
    Object.entries(paths).map(([path, timing]) => [
      path,
      {
        admissionMs: summarize(timing.admissionMs),
        completionMs: summarize(timing.completionMs),
      },
    ]),
  );
}

export function gradedPathSampleAdequacy(route, timings, minimumSamples) {
  return Object.fromEntries(
    gradedPathPairs[route].map((path) => {
      const count = timings[path]?.completionMs?.count ?? 0;
      return [
        path,
        {
          count,
          status: count >= minimumSamples ? 'sufficient' : 'inconclusive',
        },
      ];
    }),
  );
}

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
        report.benchmark.host.totalMemoryBytes !==
          firstReport.benchmark.host.totalMemoryBytes ||
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

  const stages = new Map();
  for (const report of sortedReports) {
    for (const run of report.runs) {
      const stage = stages.get(run.label) ?? [];
      stage.push({ repetition: report.benchmark.repetition, run });
      stages.set(run.label, stage);
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
          return [
            name,
            {
              samples: routeSamples.map(({ repetition, route }) => ({
                repetition,
                count: route.count,
                errorCount: route.errorCount,
              })),
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
          ];
        }),
      );
      const paths = Object.fromEntries(
        routeNames
          .filter((name) => gradedPathPairs[name] !== undefined)
          .map((name) => [
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
                return [
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
                ];
              }),
            ),
          ]),
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
      return {
        label,
        workload: samples[0].run.workload,
        offeredRateRps: samples[0].run.offeredRateRps,
        repetitionCount: samples.length,
        verdict: complete && sampleAdequate ? 'sufficient' : 'inconclusive',
        routes,
        paths,
      };
    }),
  };
}

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

export function task1PayloadFromFixture(fixture) {
  return {
    question: fixture.question,
    chart_type: fixture.topic,
    essay: fixture.essay,
    image_url: fixture.url,
  };
}

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

export function hasOneUserPerVu(maxVUs, userCount) {
  return (
    Number.isSafeInteger(maxVUs) &&
    maxVUs > 0 &&
    Number.isSafeInteger(userCount) &&
    userCount >= maxVUs
  );
}

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

export function appendStreamingMarkerChunk(previousTail, chunk, marker) {
  const combined = previousTail + chunk;
  return {
    found: combined.includes(marker),
    tail: combined.slice(-marker.length),
  };
}

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

export function metricValue(metrics, name, statistic = 'max') {
  const values = metrics[name]?.values;
  const value = values?.[statistic];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function jsonAfterPrefix(text, prefix) {
  const line = text.split(/\r?\n/).find((item) => item.includes(prefix));
  if (line === undefined) return undefined;
  const payload = line.slice(line.indexOf(prefix) + prefix.length).trim();
  const end = payload.lastIndexOf('}');
  if (end < 0) return undefined;
  const serialized = payload.slice(0, end + 1);
  return JSON.parse(
    serialized.startsWith('{\\"')
      ? serialized.replace(/\\"/g, '"')
      : serialized,
  );
}

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

export function parseDockerStats(line) {
  // Streaming `docker stats` redraws the terminal with ANSI escapes around each
  // JSON row even when stdout is a pipe.
  const stats = JSON.parse(
    line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1),
  );
  return {
    cpuPercent: parseFloat(stats.CPUPerc),
    memoryBytes: parseBytes(stats.MemUsage?.split('/')[0]?.trim() ?? ''),
  };
}

export function parseDockerImageIdentity(reference, output) {
  const separator = output.indexOf(' ');
  if (separator < 1) throw new Error('invalid Docker image inspect output');
  const repositoryDigests = JSON.parse(output.slice(separator + 1));
  if (!Array.isArray(repositoryDigests)) {
    throw new Error('invalid Docker image repository digests');
  }
  return {
    reference,
    imageId: output.slice(0, separator),
    repositoryDigests,
  };
}

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
