import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { freemem } from 'node:os';
import { relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import type {
  CoverageMap,
  CoverageMapData,
  CoverageSummaryData,
} from 'istanbul-lib-coverage';

import { resolveUnitLaneWorkers } from '../../checks/jest-worker-cap.cjs';
import { TEST_RUNNER_TARGETS } from './targets.mjs';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const require = createRequire(import.meta.url);
const coverageModule = require('istanbul-lib-coverage') as {
  createCoverageMap: (data: CoverageMapData) => CoverageMap;
};
const { createCoverageMap } = coverageModule;
const freeMemoryBytesAtStart = freemem();
const maxWorkers = resolveUnitLaneWorkers().maxWorkers;
const readyMarker = '__AIHUB_RUNNER_READY__';

type RunnerName = 'jest' | 'vitest';
interface RunnerSpec {
  entry: string;
  args: string[];
}
interface RunnerSample {
  elapsedMs: number;
  workerStartupMs: number;
  peakRssBytes: number;
  rssSamples: number;
}
interface CoverageCounts {
  total: number;
  covered: number;
  skipped: number;
}
type CoverageTotals = Record<
  'lines' | 'statements' | 'branches' | 'functions',
  CoverageCounts
>;
interface CoverageShape {
  files: Record<string, CoverageTotals>;
  total: CoverageTotals;
}
interface CoverageComparison {
  provider: 'v8';
  equivalent: boolean;
  fileCount: Record<RunnerName, number>;
  mismatchedFileCount: number;
  mismatchedFiles: string[];
  jest: CoverageTotals & {
    percentages: Record<keyof CoverageTotals, number | null>;
  };
  vitest: CoverageTotals & {
    percentages: Record<keyof CoverageTotals, number | null>;
  };
}
interface BenchmarkReport {
  node: string;
  platform: string;
  freeMemoryBytesAtStart: number;
  maxWorkers: number;
  samples: number;
  targets: readonly string[];
  methodology: {
    warmupsPerRunner: number;
    order: string;
    workerStartup: string;
    peakRss: string;
  };
  runners?: Record<RunnerName, ReturnType<typeof summarize>>;
  coverage?: CoverageComparison;
}

const runners: Record<RunnerName, RunnerSpec> = {
  jest: {
    entry: resolve(root, 'node_modules/jest/bin/jest.js'),
    args: [
      '--config',
      'scripts/ops/test-runner-benchmark/jest.config.cjs',
      '--runTestsByPath',
      ...TEST_RUNNER_TARGETS,
      '--verbose=false',
    ],
  },
  vitest: {
    entry: resolve(root, 'node_modules/vitest/vitest.mjs'),
    args: ['run', '--config', 'vitest.config.mts', '--reporter=dot'],
  },
};

function processTreeMonitor(pid: number) {
  if (process.platform === 'win32') {
    const script = `
$rootPid = ${pid}
while (Get-Process -Id $rootPid -ErrorAction SilentlyContinue) {
  $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize)
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($rootPid)
  do {
    $changed = $false
    foreach ($row in $rows) {
      if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $changed = $true }
    }
  } while ($changed)
  [long]$sum = 0
  foreach ($row in $rows) {
    if ($ids.Contains([int]$row.ProcessId)) { $sum += [long]$row.WorkingSetSize }
  }
  Write-Output "__RSS__$sum"
  Start-Sleep -Milliseconds 400
}`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  }

  const script = `root=${pid}; while kill -0 "$root" 2>/dev/null; do ps -eo pid=,ppid=,rss= | awk -v root="$root" '{ p[NR]=$1; parent[NR]=$2; rss[NR]=$3; if ($1==root) keep[NR]=1 } END { changed=1; while(changed) { changed=0; for(i=1;i<=NR;i++) if(!keep[i]) for(j=1;j<=NR;j++) if(keep[j] && parent[i]==p[j]) { keep[i]=1; changed=1; break } } total=0; for(i=1;i<=NR;i++) if(keep[i]) total+=rss[i]; print "__RSS__" total*1024 }'; sleep 0.4; done`;
  return spawn('sh', ['-c', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function runOnce(
  runnerName: RunnerName,
  extraArgs: string[] = [],
): Promise<RunnerSample> {
  const runner = runners[runnerName];
  return new Promise((resolveRun, rejectRun) => {
    const startedAt = performance.now();
    const child = spawn(
      process.execPath,
      [runner.entry, ...runner.args, ...extraArgs],
      {
        cwd: root,
        env: {
          ...process.env,
          AIHUB_JEST_MAX_WORKERS: String(maxWorkers),
          AIHUB_RUNNER_BENCHMARK: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (
      child.pid === undefined ||
      child.stdout === null ||
      child.stderr === null
    ) {
      rejectRun(
        new Error(
          `${runnerName} process did not expose a pid and output streams`,
        ),
      );
      return;
    }
    const monitor = processTreeMonitor(child.pid);
    if (monitor.stdout === null) {
      monitor.kill();
      rejectRun(new Error('RSS monitor did not expose an output stream'));
      return;
    }
    let stdout = '';
    let stderr = '';
    let workerStartupMs: number | undefined;
    let peakRssBytes = 0;
    let rssSamples = 0;
    let monitorOutput = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (workerStartupMs === undefined && stdout.includes(readyMarker)) {
        workerStartupMs = performance.now() - startedAt;
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    monitor.stdout.setEncoding('utf8');
    monitor.stdout.on('data', (chunk: string) => {
      monitorOutput += chunk;
      const lines = monitorOutput.split(/\r?\n/);
      monitorOutput = lines.pop() ?? '';
      for (const line of lines) {
        const match = /^__RSS__(\d+)$/.exec(line.trim());
        if (match) {
          peakRssBytes = Math.max(peakRssBytes, Number(match[1]));
          rssSamples += 1;
        }
      }
    });

    child.once('error', (error) => {
      monitor.kill();
      rejectRun(error);
    });
    child.once('close', (code, signal) => {
      monitor.kill();
      const elapsedMs = performance.now() - startedAt;
      if (code !== 0) {
        rejectRun(
          new Error(
            `${runnerName} exited ${code ?? signal}\n${stdout.slice(-3000)}\n${stderr.slice(-3000)}`,
          ),
        );
        return;
      }
      if (workerStartupMs === undefined || rssSamples === 0) {
        rejectRun(
          new Error(
            `${runnerName} did not emit a worker startup marker or process RSS sample`,
          ),
        );
        return;
      }
      resolveRun({ elapsedMs, workerStartupMs, peakRssBytes, rssSamples });
    });
  });
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('median requires at least one sample');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function summarize(samples: readonly RunnerSample[]) {
  return {
    runs: samples.length,
    elapsedMsMedian: median(samples.map((sample) => sample.elapsedMs)),
    elapsedMsMin: Math.min(...samples.map((sample) => sample.elapsedMs)),
    elapsedMsMax: Math.max(...samples.map((sample) => sample.elapsedMs)),
    workerStartupMsMedian: median(
      samples.map((sample) => sample.workerStartupMs),
    ),
    peakRssMbMedian: median(
      samples.map((sample) => sample.peakRssBytes / 1024 ** 2),
    ),
    peakRssMbMax: Math.max(
      ...samples.map((sample) => sample.peakRssBytes / 1024 ** 2),
    ),
    rssSamplesMin: Math.min(...samples.map((sample) => sample.rssSamples)),
  };
}

function coverageShape(reportPath: string): CoverageShape {
  const report = JSON.parse(
    readFileSync(reportPath, 'utf8'),
  ) as CoverageMapData;
  const map = createCoverageMap(report);
  const summarizeCoverage = (summary: CoverageSummaryData): CoverageTotals =>
    Object.fromEntries(
      (['lines', 'statements', 'branches', 'functions'] as const).map(
        (metric) => [
          metric,
          {
            total: summary[metric].total,
            covered: summary[metric].covered,
            skipped: summary[metric].skipped,
          },
        ],
      ),
    ) as CoverageTotals;
  const files = Object.fromEntries(
    map
      .files()
      .map((file): [string, CoverageTotals] => [
        relative(root, file).replaceAll('\\', '/'),
        summarizeCoverage(map.fileCoverageFor(file).toSummary().toJSON()),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return { files, total: summarizeCoverage(map.getCoverageSummary().toJSON()) };
}

function addPercentages({ total }: CoverageShape): CoverageComparison['jest'] {
  const percentages = Object.fromEntries(
    (['lines', 'statements', 'branches', 'functions'] as const).map(
      (metric) => [
        metric,
        total[metric].total === 0
          ? null
          : (100 * total[metric].covered) / total[metric].total,
      ],
    ),
  ) as CoverageComparison['jest']['percentages'];
  return { ...total, percentages };
}

export async function runBenchmark(
  args = process.argv.slice(2),
): Promise<void> {
  const samplesOption = args.find((arg) => arg.startsWith('--samples='));
  const samples = Number(samplesOption?.split('=')[1] ?? 5);
  const coverageOnly = args.includes('--coverage-only');
  const runCoverage = coverageOnly || args.includes('--coverage');
  if (!Number.isSafeInteger(samples) || samples < 1) {
    throw new Error('--samples must be a positive integer');
  }

  const results: Record<RunnerName, RunnerSample[]> = { jest: [], vitest: [] };
  if (!coverageOnly) {
    for (const runner of ['jest', 'vitest'] as const) {
      await runOnce(runner);
    }

    for (let index = 0; index < samples; index += 1) {
      const order: readonly RunnerName[] =
        index % 2 === 0 ? ['jest', 'vitest'] : ['vitest', 'jest'];
      for (const runner of order) {
        results[runner].push(await runOnce(runner));
      }
    }
  }

  const report: BenchmarkReport = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    freeMemoryBytesAtStart,
    maxWorkers,
    samples: coverageOnly ? 0 : samples,
    targets: TEST_RUNNER_TARGETS,
    methodology: {
      warmupsPerRunner: coverageOnly ? 0 : 1,
      order: coverageOnly ? 'Jest then Vitest' : 'alternating per sample',
      workerStartup:
        'time from runner spawn until a worker executes setupFilesAfterEnv/setupFiles',
      peakRss: 'sampled sum of runner process tree working sets every 400ms',
    },
    ...(coverageOnly
      ? {}
      : {
          runners: {
            jest: summarize(results.jest),
            vitest: summarize(results.vitest),
          },
        }),
  };

  if (runCoverage) {
    const jestCoverageArgs = [
      '--coverage',
      '--coverageReporters=json',
      '--coverageDirectory=coverage/runner-evaluation/jest',
    ];
    const vitestCoverageArgs = [
      '--coverage.enabled',
      '--coverage.provider=v8',
      '--coverage.reporter=json',
      '--coverage.reportsDirectory=coverage/runner-evaluation/vitest',
    ];
    await runOnce('jest', jestCoverageArgs);
    await runOnce('vitest', vitestCoverageArgs);
    const jestCoverage = coverageShape(
      resolve(root, 'coverage/runner-evaluation/jest/coverage-final.json'),
    );
    const vitestCoverage = coverageShape(
      resolve(root, 'coverage/runner-evaluation/vitest/coverage-final.json'),
    );
    const mismatchedFiles = [
      ...new Set([
        ...Object.keys(jestCoverage.files),
        ...Object.keys(vitestCoverage.files),
      ]),
    ].filter(
      (file) =>
        JSON.stringify(jestCoverage.files[file]) !==
        JSON.stringify(vitestCoverage.files[file]),
    );
    report.coverage = {
      provider: 'v8',
      equivalent:
        JSON.stringify(jestCoverage) === JSON.stringify(vitestCoverage),
      fileCount: {
        jest: Object.keys(jestCoverage.files).length,
        vitest: Object.keys(vitestCoverage.files).length,
      },
      mismatchedFileCount: mismatchedFiles.length,
      mismatchedFiles: mismatchedFiles.slice(0, 8),
      jest: addPercentages(jestCoverage),
      vitest: addPercentages(vitestCoverage),
    };
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.coverage && !report.coverage.equivalent) {
    process.exitCode = 1;
  }
}
