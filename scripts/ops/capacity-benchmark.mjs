import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  hasCompleteLoadDelivery,
  highestPassingRate,
  jsonAfterPrefix,
  metricValue,
  overloadRate,
  parseDockerStats,
} from './capacity-benchmark-utils.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../..');
const composeFile = path.join(
  repositoryRoot,
  'scripts/ops/capacity-benchmark.compose.yml',
);
const stageRates = positiveIntegerList(
  process.env.BENCHMARK_STAGE_RATES_RPS ?? '4,8,16,32',
);
const duration = process.env.BENCHMARK_DURATION ?? '15s';
const redisRttMs = positiveInteger(process.env.BENCHMARK_REDIS_RTT_MS ?? '60');
const stubLatencyMs = positiveInteger(
  process.env.BENCHMARK_STUB_LATENCY_MS ?? '2000',
);
const stubErrorRate = Number(process.env.BENCHMARK_STUB_ERROR_RATE ?? '0');
const maxVUs = positiveInteger(process.env.BENCHMARK_MAX_VUS ?? '256');
const appCpuLimit = 1.5;
const appMemoryLimitBytes = 768 * 1024 * 1024;
const runId = `${process.pid}-${Date.now()}`;
const projectName = `aihub-capacity-${runId}`;
const artifactDirectory = path.join(
  repositoryRoot,
  'artifacts/capacity-benchmark',
  runId,
);

if (process.argv.includes('--help')) {
  process.stdout.write(
    'Run the isolated local capacity benchmark. Configure BENCHMARK_STAGE_RATES_RPS, BENCHMARK_DURATION, BENCHMARK_REDIS_RTT_MS, BENCHMARK_STUB_LATENCY_MS, BENCHMARK_STUB_ERROR_RATE, and BENCHMARK_MAX_VUS.\n',
  );
  process.exit(0);
}

if (
  stageRates.length < 2 ||
  stageRates.some(
    (rate, index) => index > 0 && rate <= stageRates[index - 1],
  ) ||
  !/^\d+s$/.test(duration) ||
  redisRttMs % 2 !== 0 ||
  !Number.isFinite(stubErrorRate) ||
  stubErrorRate < 0 ||
  stubErrorRate > 1
) {
  throw new Error('invalid capacity benchmark settings');
}

const benchmarkRevision = gitRevision();
await mkdir(artifactDirectory, { recursive: true });
const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const benchmarkEnvironment = {
  ...process.env,
  BENCHMARK_VCS_REF: benchmarkRevision,
  BENCHMARK_JWT_PRIVATE_KEY_B64: Buffer.from(
    appKey.export({ type: 'pkcs8', format: 'pem' }),
  ).toString('base64'),
  BENCHMARK_REDIS_ONE_WAY_DELAY_MS: String(redisRttMs / 2),
  BENCHMARK_STUB_LATENCY_MS: String(stubLatencyMs),
  BENCHMARK_STUB_ERROR_RATE: String(stubErrorRate),
};
const composePrefix = [
  'compose',
  '--project-name',
  projectName,
  '--file',
  composeFile,
];
const startedAt = new Date();
const runs = [];
let statsWatcher;
let hostWatcher;

try {
  process.stdout.write('Building the isolated benchmark images...\n');
  await dockerCompose(['build', 'aihub', 'seed']);
  if (gitRevision() !== benchmarkRevision) {
    throw new Error(
      'Git checkout changed while the benchmark images were built',
    );
  }
  process.stdout.write(
    'Starting disposable Postgres, Redis, and AI Service stub...\n',
  );
  await dockerCompose(['up', '-d', 'postgres', 'redis', 'benchmark-support']);
  await dockerCompose([
    'run',
    '--rm',
    '--no-deps',
    'aihub',
    'scripts/cli/migrate.mjs',
  ]);
  await dockerCompose(['run', '--rm', '--no-deps', 'seed']);
  await dockerCompose(['up', '-d', 'aihub']);
  const appContainerId = await waitForHealthyApp();
  const dockerInfo = await readDockerInfo();
  statsWatcher = watchDockerStats(appContainerId);
  hostWatcher = watchHostResources();

  const gradingRoutes = [
    'writing_task1',
    'writing_task2',
    'speaking_multipart',
    'speaking_json',
  ];
  const authRoutes = ['login', 'refresh', 'web_session_exchange'];
  const routeNames = [...gradingRoutes, ...authRoutes];
  const scenarios = [
    ...gradingRoutes.map((name) => ({ workload: name, routeNames: [name] })),
    { workload: 'mixed_grading', routeNames: gradingRoutes },
    ...authRoutes.map((name) => ({ workload: name, routeNames: [name] })),
    { workload: 'auth_and_grading', routeNames },
  ];

  for (const scenario of scenarios) {
    for (const rate of stageRates) {
      const label = `${scenario.workload} at ${rate} offered requests/s`;
      process.stdout.write(`Running ${label}...\n`);
      runs.push(
        await runK6({
          appContainerId,
          workload: scenario.workload,
          rate,
          routeNames: scenario.routeNames,
          runDuration: duration,
          label,
        }),
      );
    }
  }

  const deadlines = {
    writing_task1: 60_000,
    writing_task2: 60_000,
    speaking_multipart: 60_000,
    speaking_json: 30_000,
  };
  const mixedRuns = runs.filter((run) => run.workload === 'mixed_grading');
  const mixedSafeRate = highestPassingRate(mixedRuns, gradingRoutes, deadlines);
  const capacityByRoute = Object.fromEntries(
    gradingRoutes.map((name) => [
      name,
      {
        deadlineMs: deadlines[name],
        highestPassingRateRps: highestPassingRate(
          runs.filter((run) => run.workload === name),
          [name],
          deadlines[name],
        ),
      },
    ]),
  );
  const firstMixedCeiling = mixedRuns.find(
    (run) =>
      !hasCompleteLoadDelivery(run) ||
      gradingRoutes.some((name) => {
        const route = run.routes[name];
        return (
          route === undefined ||
          route.count === 0 ||
          route.p99Ms === null ||
          route.p99Ms > deadlines[name] ||
          route.errorCount > 0
        );
      }),
  );
  const nextOverloadRate = overloadRate(stageRates, mixedSafeRate);
  process.stdout.write(
    `Running one controlled overload stage at ${nextOverloadRate} offered requests/s...\n`,
  );
  runs.push(
    await runK6({
      appContainerId,
      workload: 'mixed_grading',
      rate: nextOverloadRate,
      routeNames: gradingRoutes,
      runDuration: duration,
      label: `mixed_grading overload at ${nextOverloadRate} offered requests/s`,
      isOverload: true,
    }),
  );

  const recoveryRate = mixedSafeRate || stageRates[0];
  if (recoveryRate === undefined) throw new Error('no recovery rate available');
  process.stdout.write(
    `Running post-overload recovery at ${recoveryRate} requests/s...\n`,
  );
  runs.push(
    await runK6({
      appContainerId,
      workload: 'mixed_grading',
      rate: recoveryRate,
      routeNames: gradingRoutes,
      runDuration: '30s',
      label: `post-overload recovery at ${recoveryRate} requests/s`,
      isRecovery: true,
    }),
  );

  const contentionRate = mixedSafeRate || stageRates[0];
  if (contentionRate === undefined)
    throw new Error('no capacity rate available');
  process.stdout.write(
    `Running quota reconciliation and usage reporting under mixed grading at ${contentionRate} requests/s...\n`,
  );
  const contention = await runJobContention({
    appContainerId,
    rate: contentionRate,
    routeNames: gradingRoutes,
  });
  runs.push(contention.load);

  await new Promise((resolve) => setTimeout(resolve, 1100));
  statsWatcher.stop();
  hostWatcher.stop();

  const report = {
    benchmark: {
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      runtimeCommit: benchmarkRevision,
      host: {
        operatingSystem: `${os.type()} ${os.release()}`,
        architecture: os.arch(),
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        dockerEngineCpuCount: dockerInfo.NCPU,
        dockerEngineMemoryBytes: dockerInfo.MemTotal,
        dockerEngineVersion: dockerInfo.ServerVersion,
      },
      target: {
        nodeEnvironment: 'test',
        cpuLimit: appCpuLimit,
        memoryLimitBytes: appMemoryLimitBytes,
      },
      redis: {
        configuredRoundTripLatencyMs: redisRttMs,
        oneWayDelayMs: redisRttMs / 2,
        proxy:
          'local TCP proxy; 30ms in each direction at the default 60ms RTT',
      },
      downstreamStub: {
        latencyMs: stubLatencyMs,
        errorRate: stubErrorRate,
        fixtures: [
          'test/fixtures/ai-writing/grade-task1.response.json',
          'test/fixtures/ai-writing/grade-task2.response.json',
          'test/fixtures/ai-speaking/grading.response.json',
        ],
      },
      generator: {
        runner: 'grafana/k6:0.54.0',
        placement:
          'separate Docker container on the isolated benchmark network',
        maxVUs,
      },
      configuration: {
        stageRatesRps: stageRates,
        holdDuration: duration,
        gradingRouteDeadlinesMs: deadlines,
        highestPassingRateByGradingRoute: capacityByRoute,
        mixedGradingWeights: {
          writingTask1: 0.25,
          writingTask2: 0.25,
          speakingMultipart: 0.25,
          speakingJson: 0.25,
        },
        syntheticOrganizations: 4,
        maxConcurrentPerOrganization: 20,
        syntheticPreverifiedMfaDisabledUsers: 512,
        syntheticUsageRows: 100000,
        passwordHash: 'Argon2id m=65536,t=3,p=1',
      },
      thresholds: {
        gradingP99Ms: deadlines,
        appCpuLimitCores: appCpuLimit,
        appMemoryLimitBytes,
        appCpuPercentOfLimit: 80,
        appMemoryPercentOfLimit: 80,
        postgresqlPoolWaitingClients: 0,
        hostCpuPercent: 80,
        hostMemoryPercentUsed: 80,
        stubErrorRate: stubErrorRate,
      },
      firstMixedGradingCeiling:
        firstMixedCeiling === undefined
          ? {
              reached: false,
              details:
                'No mixed stage exceeded a grading deadline, returned an API error, or failed to deliver its offered load.',
            }
          : {
              reached: true,
              offeredRateRps: firstMixedCeiling.offeredRateRps,
              routeResults: firstMixedCeiling.routes,
            },
      jobContention: {
        jobs: contention.jobs,
        thresholds: contention.thresholds,
        hostWideLockDefersCompetingJobs:
          contention.hostWideLockDefersCompetingJobs,
      },
    },
    runs,
    sampledResources: {
      appContainer: statsWatcher.samples,
      host: hostWatcher.samples,
      appContainerPeak: peak(statsWatcher.samples),
      hostPeak: peak(hostWatcher.samples),
    },
    note: 'Local isolated workload only. It is not an exact capacity claim for the shared 2-vCPU Production host.',
  };
  const resultPath = path.join(artifactDirectory, 'results.json');
  await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Benchmark report written to ${resultPath}\n`);
} catch (error) {
  process.stderr.write(
    `Capacity benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  statsWatcher?.stop();
  hostWatcher?.stop();
  await dockerCompose(['down', '--volumes', '--remove-orphans']).catch(
    (error) => {
      process.stderr.write(`Benchmark cleanup failed: ${error.message}\n`);
      process.exitCode = 1;
    },
  );
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value))
    throw new Error('benchmark setting must be an integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('benchmark setting must be a positive safe integer');
  }
  return parsed;
}

function positiveIntegerList(value) {
  const items = value.split(',').map((item) => positiveInteger(item));
  if (new Set(items).size !== items.length) {
    throw new Error('benchmark rate stages must be unique');
  }
  return items;
}

function gitRevision() {
  if (
    runSync('git', ['status', '--porcelain', '--untracked-files=all']).trim()
  ) {
    throw new Error(
      'capacity benchmark requires a clean Git working tree so the image matches its revision',
    );
  }
  const result = runSync('git', ['rev-parse', 'HEAD']);
  return result.trim();
}

function runSync(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} failed`);
  }
  return result.stdout;
}

function dockerCompose(args, options = {}) {
  return runProcess('docker', [...composePrefix, ...args], {
    ...options,
    env: benchmarkEnvironment,
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk);
      options.onStdout?.(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk);
      options.onStderr?.(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0 && !options.allowNonZeroExit) {
        reject(
          new Error(
            `${command} exited ${code}: ${lastLines(stderr || stdout, 30)}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

function appendLimited(current, chunk) {
  const result = current + chunk;
  return result.length > 8_000_000 ? result.slice(-8_000_000) : result;
}

function lastLines(value, limit) {
  return value
    .split(/\r?\n/)
    .slice(-limit)
    .map((line) => (line.length > 2000 ? '[omitted long output line]' : line))
    .join('\n')
    .trim();
}

async function waitForHealthyApp() {
  const containerId = (
    await dockerCompose(['ps', '-q', 'aihub'])
  ).stdout.trim();
  if (containerId.length === 0)
    throw new Error('AIHUB container was not created');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const health = await runProcess(
      'docker',
      ['inspect', '--format', '{{.State.Health.Status}}', containerId],
      { env: benchmarkEnvironment },
    ).catch(() => ({ stdout: '' }));
    if (health.stdout.trim() === 'healthy') return containerId;
    if (health.stdout.trim() === 'unhealthy') {
      throw new Error('AIHUB benchmark container became unhealthy');
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('AIHUB did not become healthy within 120 seconds');
}

async function readDockerInfo() {
  const result = await runProcess(
    'docker',
    ['info', '--format', '{{json .}}'],
    { env: benchmarkEnvironment },
  );
  return JSON.parse(result.stdout.trim());
}

async function dockerRestartCount(containerId) {
  const result = await runProcess(
    'docker',
    ['inspect', '--format', '{{.RestartCount}}', containerId],
    { env: benchmarkEnvironment },
  );
  const count = Number(result.stdout.trim());
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('could not read AIHUB container restart count');
  }
  return count;
}

async function runK6({
  appContainerId,
  workload,
  rate,
  routeNames,
  runDuration,
  label,
  isOverload = false,
  isRecovery = false,
}) {
  if (routeNames.includes('refresh')) {
    await dockerCompose([
      'run',
      '--rm',
      '--no-deps',
      'seed',
      'node',
      'scripts/ops/capacity-benchmark-reset-refresh-tokens.mjs',
    ]);
  }
  const restartCountBefore = await dockerRestartCount(appContainerId);
  const startMs = Date.now();
  const startIso = new Date(startMs).toISOString();
  const result = await dockerCompose([
    'run',
    '--rm',
    '--no-deps',
    '-e',
    `WORKLOAD=${workload}`,
    '-e',
    `RATE=${rate}`,
    '-e',
    `DURATION=${runDuration}`,
    '-e',
    `MAX_VUS=${maxVUs}`,
    'k6',
    'run',
    '/scripts/capacity-benchmark-k6.js',
  ]);
  const endMs = Date.now();
  const output = `${result.stdout}\n${result.stderr}`;
  const summary = jsonAfterPrefix(output, 'BENCHMARK_SUMMARY_JSON ');
  const stub = jsonAfterPrefix(output, 'BENCHMARK_STUB_STATS ');
  if (summary === undefined || stub === undefined) {
    throw new Error(
      `${label}: k6 did not return its summary and stub counters\n${lastLines(result.stdout, 20)}\n${lastLines(result.stderr, 20)}`,
    );
  }
  const logs = await requestTimingLogs(appContainerId, startIso, startMs);
  const routeResults = Object.fromEntries(
    routeNames.map((name) => [
      name,
      routeSummary(summary.metrics, name, logs[name]),
    ]),
  );
  const requestCount = Object.values(routeResults).reduce(
    (sum, route) => sum + route.count,
    0,
  );
  for (const route of Object.values(routeResults)) {
    route.responseShare =
      requestCount === 0 ? null : route.count / requestCount;
  }
  const appSamples = samplesInWindow(
    statsWatcher?.samples ?? [],
    startMs,
    endMs,
  );
  const hostSamples = samplesInWindow(
    hostWatcher?.samples ?? [],
    startMs,
    endMs,
  );
  const appResourcePeak = peak(appSamples);
  const hostResourcePeak = peak(hostSamples);
  const restartCountAfter = await dockerRestartCount(appContainerId);

  return {
    workload,
    label,
    offeredRateRps: rate,
    holdDuration: runDuration,
    completedRequests: requestCount,
    completedRateRps: round(requestCount / Number.parseInt(runDuration, 10), 2),
    droppedIterations:
      metricValue(summary.metrics, 'dropped_iterations', 'count') ?? 0,
    routes: routeResults,
    appResourceSampleCount: appSamples.length,
    hostResourceSampleCount: hostSamples.length,
    injectedStubErrors: stub.errors,
    processRssPeakBytes: metricValue(
      summary.metrics,
      'benchmark_process_rss_bytes',
    ),
    processHeapPeakBytes: metricValue(
      summary.metrics,
      'benchmark_process_heap_bytes',
    ),
    eventLoopLagPeakSeconds: metricValue(
      summary.metrics,
      'benchmark_event_loop_lag_seconds',
    ),
    postgresPoolWaitingPeak: poolWaitingPeaks(summary.metrics),
    downstreamQueuedPeak: downstreamQueuePeaks(summary.metrics),
    redisRttMs: stub.redisRoundTripDelayMs,
    isOverload,
    isRecovery,
    restartCount: restartCountAfter,
    restartsDuringRun: Math.max(0, restartCountAfter - restartCountBefore),
    appContainerResourcePeak: {
      ...appResourcePeak,
      cpuPercentOfLimit:
        typeof appResourcePeak.cpuPercent === 'number'
          ? round((appResourcePeak.cpuPercent / (appCpuLimit * 100)) * 100, 2)
          : null,
      memoryPercentOfLimit:
        typeof appResourcePeak.memoryBytes === 'number'
          ? round((appResourcePeak.memoryBytes / appMemoryLimitBytes) * 100, 2)
          : null,
    },
    hostResourcePeak: {
      ...hostResourcePeak,
      memoryPercentUsed:
        typeof hostResourcePeak.usedMemoryBytes === 'number'
          ? round((hostResourcePeak.usedMemoryBytes / os.totalmem()) * 100, 2)
          : null,
    },
  };
}

function routeSummary(metrics, name, logTiming) {
  const latency = metrics[`benchmark_latency_${name}`]?.values ?? {};
  const routePaths = {
    writing_task1: '/v1/ielts/writing/task1/grade',
    writing_task2: '/v1/ielts/writing/task2/grade',
    speaking_multipart: '/v1/ielts/speaking/grading',
    speaking_json: '/v1/ielts/speaking/grading-json',
    login: '/v1/auth/login',
    refresh: '/v1/auth/refresh',
    web_session_exchange: '/v1/auth/web-sessions/exchange',
  };
  const pathName = routePaths[name];
  const p99Ms = finite(latency['p(99)']);
  const p95Ms = finite(latency['p(95)']);
  const timing = logTiming ?? { totalMs: [], admissionMs: [] };
  return {
    path: pathName,
    count:
      metricValue(metrics, `benchmark_api_responses_${name}`, 'count') ?? 0,
    p50Ms: finite(latency.med),
    p95Ms,
    p99Ms,
    errorCount:
      metricValue(metrics, `benchmark_api_errors_${name}`, 'count') ?? 0,
    correctedTotalMs: percentileSet(timing.totalMs),
    admissionMs: percentileSet(timing.admissionMs),
    downstreamMs: {
      p50: finite(metrics[`benchmark_downstream_${name}`]?.values?.med),
      p95: finite(metrics[`benchmark_downstream_${name}`]?.values?.['p(95)']),
      p99: finite(metrics[`benchmark_downstream_${name}`]?.values?.['p(99)']),
    },
    gatewayTotalMs: {
      p50: finite(metrics[`benchmark_gateway_total_${name}`]?.values?.med),
      p95: finite(
        metrics[`benchmark_gateway_total_${name}`]?.values?.['p(95)'],
      ),
      p99: finite(
        metrics[`benchmark_gateway_total_${name}`]?.values?.['p(99)'],
      ),
    },
  };
}

async function requestTimingLogs(containerId, since, sinceMs) {
  const output = await runProcess(
    'docker',
    ['logs', `--since=${since}`, containerId],
    { env: benchmarkEnvironment },
  ).catch(() => ({ stdout: '' }));
  const results = {};
  const byPath = {
    '/v1/ielts/writing/task1/grade': 'writing_task1',
    '/v1/ielts/writing/task2/grade': 'writing_task2',
    '/v1/ielts/speaking/grading': 'speaking_multipart',
    '/v1/ielts/speaking/grading-json': 'speaking_json',
    '/v1/auth/login': 'login',
    '/v1/auth/refresh': 'refresh',
    '/v1/auth/web-sessions/exchange': 'web_session_exchange',
  };
  for (const line of output.stdout.split(/\r?\n/)) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    let event;
    try {
      event = JSON.parse(line.slice(start));
    } catch {
      continue;
    }
    const timeMs =
      typeof event.time === 'number' ? event.time : Date.parse(event.time);
    if (!Number.isFinite(timeMs) || timeMs < sinceMs) continue;
    const name =
      Object.entries({
        'writing.task1.grade': 'writing_task1',
        'writing.task2.grade': 'writing_task2',
        'speaking.grading': 'speaking_multipart',
        'speaking.grading-json': 'speaking_json',
      }).find(([operation]) => operation === event.operation)?.[1] ??
      byPath[event.route];
    if (name === undefined) continue;
    const record = (results[name] ??= { totalMs: [], admissionMs: [] });
    if (Number.isFinite(event.total_ms)) record.totalMs.push(event.total_ms);
    if (Number.isFinite(event.admission_ms)) {
      record.admissionMs.push(event.admission_ms);
    }
  }
  return results;
}

function poolWaitingPeaks(metrics) {
  const peak = metricValue(metrics, 'benchmark_postgres_waiting');
  return peak === null ? {} : { allPools: peak };
}

function downstreamQueuePeaks(metrics) {
  const peak = metricValue(metrics, 'benchmark_downstream_queued');
  return peak === null ? {} : { allOrigins: peak };
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? round(value, 2)
    : null;
}

function percentileSet(values) {
  if (values.length === 0) return { count: 0, p50: null, p95: null, p99: null };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction) =>
    sorted[Math.ceil(fraction * sorted.length) - 1];
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function watchDockerStats(containerId) {
  const samples = [];
  const child = spawn(
    'docker',
    ['stats', '--format', '{{json .}}', containerId],
    {
      cwd: repositoryRoot,
      env: benchmarkEnvironment,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/[\r\n]+/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        samples.push({
          at: new Date().toISOString(),
          ...parseDockerStats(line),
        });
      } catch {
        // A Docker stats header is not a sample.
      }
    }
  });
  return { samples, stop: () => child.kill() };
}

function watchHostResources() {
  const samples = [];
  let previous = cpuTimes();
  const sample = () => {
    const current = cpuTimes();
    const idleDelta = current.idle - previous.idle;
    const totalDelta = current.total - previous.total;
    previous = current;
    samples.push({
      at: new Date().toISOString(),
      cpuPercent:
        totalDelta > 0 ? round((1 - idleDelta / totalDelta) * 100, 2) : null,
      usedMemoryBytes: os.totalmem() - os.freemem(),
      freeMemoryBytes: os.freemem(),
    });
  };
  sample();
  const timer = setInterval(sample, 1000);
  timer.unref();
  return { samples, stop: () => clearInterval(timer) };
}

function cpuTimes() {
  return os.cpus().reduce(
    (totals, cpu) => ({
      idle: totals.idle + cpu.times.idle,
      total:
        totals.total +
        Object.values(cpu.times).reduce((sum, time) => sum + time, 0),
    }),
    { idle: 0, total: 0 },
  );
}

function peak(samples) {
  const fields = ['cpuPercent', 'memoryBytes', 'usedMemoryBytes'];
  if (samples.length === 0) {
    return Object.fromEntries(fields.map((field) => [field, null]));
  }
  return Object.fromEntries(
    fields.map((field) => [
      field,
      samples.reduce(
        (maximum, sample) =>
          typeof sample[field] === 'number'
            ? Math.max(maximum, sample[field])
            : maximum,
        0,
      ),
    ]),
  );
}

function samplesInWindow(samples, startMs, endMs) {
  return samples.filter((sample) => {
    const at = Date.parse(sample.at);
    return at >= startMs && at <= endMs;
  });
}

async function runJobContention({ appContainerId, rate, routeNames }) {
  const duration = '30s';
  const startMs = Date.now();
  const loadPromise = runK6({
    appContainerId,
    workload: 'mixed_grading',
    rate,
    routeNames,
    runDuration: duration,
    label: `scheduled-job contention at ${rate} requests/s`,
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const windowStart = new Date(startMs - 60 * 60 * 1000).toISOString();
  const windowEnd = new Date().toISOString();
  const jobsPromise = Promise.all([
    runAppCommand(appContainerId, ['quota:reconcile']),
    runAppCommand(appContainerId, [
      'usage:report',
      '--from',
      windowStart,
      '--to',
      windowEnd,
    ]),
  ]);
  const [jobsResult, loadResult] = await Promise.allSettled([
    jobsPromise,
    loadPromise,
  ]);
  if (jobsResult.status === 'rejected') throw jobsResult.reason;
  if (loadResult.status === 'rejected') throw loadResult.reason;
  const jobs = jobsResult.value;
  const load = loadResult.value;
  const deadlines = {
    writing_task1: 60_000,
    writing_task2: 60_000,
    speaking_multipart: 60_000,
    speaking_json: 30_000,
  };
  const poolCounts = Object.values(load.postgresPoolWaitingPeak);
  const maxPoolWait = Math.max(0, ...poolCounts);
  const appCpuPercent = load.appContainerResourcePeak.cpuPercentOfLimit;
  const appMemoryPercent = load.appContainerResourcePeak.memoryPercentOfLimit;
  const hostCpuPercent = load.hostResourcePeak.cpuPercent;
  const hostMemoryPercent = load.hostResourcePeak.memoryPercentUsed;
  const gradingWithinDeadline = routeNames.every((name) => {
    const route = load.routes[name];
    return (
      route !== undefined &&
      route.p99Ms !== null &&
      route.p99Ms <= deadlines[name] &&
      route.errorCount === 0
    );
  });
  const thresholdResults = {
    offeredLoadFullyDelivered: hasCompleteLoadDelivery(load),
    gradingP99WithinDeadline: gradingWithinDeadline,
    appCpuBelow80PercentOfLimit:
      typeof appCpuPercent === 'number' && appCpuPercent <= 80,
    appMemoryBelow80PercentOfLimit:
      typeof appMemoryPercent === 'number' && appMemoryPercent <= 80,
    postgresPoolWaitingClientsZero: poolCounts.length > 0 && maxPoolWait === 0,
    hostCpuBelow80Percent:
      typeof hostCpuPercent === 'number' && hostCpuPercent <= 80,
    hostMemoryBelow80Percent:
      typeof hostMemoryPercent === 'number' && hostMemoryPercent <= 80,
    scheduledJobsSucceeded: jobs.every((job) => job.exitCode === 0),
  };
  return {
    jobs: jobs.map((job, index) => ({
      name: index === 0 ? 'quota:reconcile' : 'usage:report',
      exitCode: job.exitCode,
      outputTail: lastLines(job.stderr || job.stdout, 4),
      durationMs: job.durationMs,
    })),
    thresholds: {
      limits: {
        gradingP99Ms: deadlines,
        appCpuPercentOfLimit: 80,
        appMemoryPercentOfLimit: 80,
        postgresPoolWaitingClients: 0,
        hostCpuPercent: 80,
        hostMemoryPercentUsed: 80,
      },
      observed: {
        appCpuPercentOfLimit: appCpuPercent,
        appMemoryPercentOfLimit: appMemoryPercent,
        postgresPoolWaitingClients: maxPoolWait,
        hostCpuPercent,
        hostMemoryPercentUsed: hostMemoryPercent,
      },
      checks: thresholdResults,
      allPassed: Object.values(thresholdResults).every(Boolean),
      deferPolicyRequired: !Object.values(thresholdResults).every(Boolean),
    },
    hostWideLockDefersCompetingJobs:
      'validated by scripts/ops/host-scheduled-job.spec.sh',
    load,
  };
}

async function runAppCommand(containerId, args) {
  const start = Date.now();
  const result = await runProcess(
    'docker',
    [
      'exec',
      containerId,
      'node',
      '/benchmark/start-app.mjs',
      'scripts/cli/cli.mjs',
      ...args,
    ],
    { env: benchmarkEnvironment, allowNonZeroExit: true },
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - start,
  };
}
