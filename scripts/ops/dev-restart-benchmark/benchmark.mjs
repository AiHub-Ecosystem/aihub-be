#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** @typedef {import('node:child_process').ChildProcess} ChildProcess */
/** @typedef {{baselineMs: number, budgetMs: number}} PhaseLimit */
/** @typedef {{name: string, phases: Record<string, PhaseLimit>}} Baseline */
/** @typedef {{child: ChildProcess, error?: Error, lines: string[], ready: Array<{monotonicMs: number, epochMs: number}>}} Tracker */
/** @typedef {{child?: ChildProcess, workspaceRoot?: string, tempParent?: string}} Resources */

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const baselinePath = path.join(scriptDirectory, 'baseline.json');
const runtimeFiles = [
  'package.json',
  'nest-cli.json',
  'tsconfig.json',
  'tsconfig.build.json',
  '.swcrc',
  'prisma.config.ts',
  'prisma/schema.prisma',
  'scripts/generate/generate-prisma-client.mjs',
  'scripts/generate/prisma-client-stamp.cjs',
];
const probeName = 'dev-restart-budget-probe';
const readyMessage = 'Nest application successfully started';
// arch-check: #225 requires the real pnpm dev command despite ADR-0139.
/** @type {'SIGINT' | 'SIGTERM' | undefined} */
let interruptSignal;

/** @param {Record<string, number>} measurements @param {Baseline} baseline */
export function comparePhases(measurements, baseline) {
  return Object.entries(baseline.phases).map(([phase, limits]) => ({
    phase,
    measuredMs: measurements[phase],
    baselineMs: limits.baselineMs,
    budgetMs: limits.budgetMs,
    passed: measurements[phase] <= limits.budgetMs,
  }));
}

/** @param {string} [root] @param {string} [tempParent] @param {string} [dependencies] */
export function createWorkspace(
  root = repositoryRoot,
  tempParent = path.join(root, 'temp'),
  dependencies = path.join(root, 'node_modules'),
) {
  if (!existsSync(dependencies)) {
    throw new Error(
      'Install repository dependencies before running the benchmark.',
    );
  }

  mkdirSync(tempParent, { recursive: true });
  const workspaceRoot = mkdtempSync(path.join(tempParent, 'dev-restart-'));
  try {
    for (const input of ['src']) {
      cpSync(path.join(root, input), path.join(workspaceRoot, input), {
        recursive: true,
      });
    }
    for (const input of runtimeFiles) {
      const target = path.join(workspaceRoot, input);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(root, input), target);
    }
    symlinkSync(
      realpathSync(dependencies),
      path.join(workspaceRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return workspaceRoot;
  } catch (error) {
    rmSync(workspaceRoot, { recursive: true, force: true });
    throw error;
  }
}

/** @template T @param {Resources} resources @param {() => Promise<T>} operation @returns {Promise<T>} */
export async function withBenchmarkCleanup(resources, operation) {
  /** @type {T | undefined} */
  let result;
  /** @type {unknown} */
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  /** @type {unknown} */
  let cleanupError;
  try {
    await cleanupBenchmark(resources);
  } catch (error) {
    cleanupError = error;
  }
  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      'The benchmark failed and cleanup was incomplete.',
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return /** @type {T} */ (result);
}

/** @param {Resources} resources */
async function cleanupBenchmark({ child, workspaceRoot, tempParent }) {
  /** @type {unknown} */
  let cleanupError;
  try {
    await stopProcessTree(child);
  } catch (error) {
    cleanupError = error;
  }
  if (workspaceRoot) {
    try {
      rmSync(workspaceRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError = cleanupError
        ? new AggregateError(
            [cleanupError, error],
            'Could not remove benchmark files.',
          )
        : error;
    }
  }
  if (tempParent) {
    try {
      rmdirSync(tempParent);
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
        cleanupError = cleanupError
          ? new AggregateError(
              [cleanupError, error],
              'Could not remove benchmark temp folder.',
            )
          : error;
      }
    }
  }
  if (cleanupError) throw cleanupError;
}

/** @param {ChildProcess | undefined} child */
function childExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

/** @param {ChildProcess} child @param {number} timeoutMs */
function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

/** @param {number} processGroupId */
function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

/** @param {number} processGroupId @param {number} timeoutMs */
async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/** @param {number} processGroupId @param {NodeJS.Signals} signal */
function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH')
      throw error;
  }
}

/** @param {ChildProcess | undefined} child */
async function stopProcessTree(child) {
  if (!child || child.pid === undefined) return;
  if (process.platform === 'win32') {
    if (!childExited(child)) {
      const result = spawnSync(
        'taskkill',
        ['/pid', String(child.pid), '/T', '/F'],
        {
          stdio: 'ignore',
        },
      );
      if (result.error) throw result.error;
      if (result.status !== 0 && result.status !== 128) {
        throw new Error(`taskkill failed with status ${result.status}.`);
      }
    }
  } else {
    signalProcessGroup(child.pid, 'SIGTERM');
    if (!(await waitForProcessGroupExit(child.pid, 2000))) {
      signalProcessGroup(child.pid, 'SIGKILL');
    }
    if (!(await waitForProcessGroupExit(child.pid, 5000))) {
      throw new Error('The pnpm dev process tree did not stop.');
    }
  }
  if (!(await waitForChildExit(child, 5000))) {
    throw new Error('The pnpm dev process tree did not stop.');
  }
}

/** @param {string} filename @returns {Record<string, string>} */
function readEnvFile(filename) {
  return Object.fromEntries(
    readFileSync(filename, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

/** @param {string} workspaceRoot @param {string} markersPath @returns {NodeJS.ProcessEnv} */
function createRuntimeEnvironment(workspaceRoot, markersPath) {
  const runtimeDirectory = path.join(workspaceRoot, '.benchmark-runtime');
  const require = createRequire(import.meta.url);
  const ciBootConfig =
    /** @type {{writeBootConfig(directory: string): void}} */ (
      require(path.join(repositoryRoot, 'scripts/ci/ci-boot-config.cjs'))
    );
  ciBootConfig.writeBootConfig(runtimeDirectory);

  const env = {
    ...process.env,
    ...readEnvFile(path.join(runtimeDirectory, 'boot.env')),
    NODE_ENV: 'development',
    PORT: '0',
    AIHUB_LISTEN_SOCKET: '',
    AIHUB_RUNTIME_SECRETS_FILE: path.join(
      runtimeDirectory,
      'runtime-secrets.json',
    ),
    AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: path.join(
      runtimeDirectory,
      'connection-secrets.json',
    ),
    AIHUB_AUTH_MFA_SECRETS_FILE: path.join(
      runtimeDirectory,
      'auth-mfa-secrets.json',
    ),
    AIHUB_RESTART_BENCHMARK_MARKERS: markersPath,
    PNPM_CONFIG_PM_ON_FAIL: 'ignore',
  };
  writeFileSync(
    path.join(workspaceRoot, '.npmrc'),
    'verify-deps-before-run=warn\nconfirm-modules-purge=false\n',
  );
  const preload = '--require=./.restart-benchmark-process.cjs';
  env.NODE_OPTIONS = [env.NODE_OPTIONS, preload].filter(Boolean).join(' ');

  writeFileSync(
    path.join(workspaceRoot, '.restart-benchmark-process.cjs'),
    "const { appendFileSync } = require('node:fs');\n" +
      "const { basename } = require('node:path');\n" +
      "if (process.env.AIHUB_RESTART_BENCHMARK_MARKERS && /^main(?:\\.js)?$/i.test(basename(process.argv[1] ?? ''))) {\n" +
      '  appendFileSync(process.env.AIHUB_RESTART_BENCHMARK_MARKERS, `${process.pid},${Date.now()}\\n`);\n' +
      '}\n',
  );
  return env;
}

/** @param {string} workspaceRoot @param {NodeJS.ProcessEnv} env @returns {Tracker} */
function startDev(workspaceRoot, env) {
  const windows = process.platform === 'win32';
  const configArgs = [
    '--config.pm-on-fail=ignore',
    '--config.verify-deps-before-run=warn',
    '--config.confirm-modules-purge=false',
  ];
  const child = spawn(
    windows
      ? (process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe')
      : 'pnpm',
    windows
      ? ['/d', '/s', '/c', 'pnpm', ...configArgs, 'dev']
      : [...configArgs, 'dev'],
    {
      cwd: workspaceRoot,
      env,
      detached: !windows,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const tracker = { child, error: undefined, lines: [], ready: [] };

  for (const stream of [child.stdout, child.stderr]) {
    const reader = createInterface({ input: stream });
    reader.on('line', (line) => {
      tracker.lines.push(line);
      if (tracker.lines.length > 100) tracker.lines.shift();
      if (line.includes(readyMessage)) {
        tracker.ready.push({
          monotonicMs: performance.now(),
          epochMs: Date.now(),
        });
      }
    });
  }
  child.once('error', (error) => {
    tracker.error = error;
  });
  return tracker;
}

/** @param {string} markersPath @returns {Array<{pid: number, startedAt: number}>} */
function appStarts(markersPath) {
  if (!existsSync(markersPath)) return [];
  return readFileSync(markersPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, startedAt] = line.split(',').map(Number);
      return { pid, startedAt };
    });
}

/** @param {Tracker} tracker */
function assertDevRunning(tracker) {
  if (tracker.error) {
    throw new Error(`Could not start pnpm dev: ${tracker.error.message}`);
  }
  if (childExited(tracker.child)) {
    const diagnostics = tracker.lines
      .filter((line) =>
        /\b(error|failed|fatal|exception|cannot|missing|invalid)\b/i.test(line),
      )
      .slice(-5)
      .join(' | ');
    throw new Error(
      `pnpm dev exited before readiness (code=${tracker.child.exitCode ?? 'none'}, signal=${tracker.child.signalCode ?? 'none'})${diagnostics ? `: ${diagnostics}` : '.'}`,
    );
  }
  if (interruptSignal)
    throw new Error(`Benchmark interrupted by ${interruptSignal}.`);
}

/**
 * @template T
 * @param {Tracker} tracker
 * @param {() => T | null | undefined | false} predicate
 * @param {string} label
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
async function waitFor(tracker, predicate, label, timeoutMs = 60_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    assertDevRunning(tracker);
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** @param {number} pid */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

/** @param {Resources} resources @returns {Promise<Record<'compile' | 'shutdown' | 'boot', number>>} */
async function runMeasurement(resources) {
  const tempParent = path.join(repositoryRoot, 'temp');
  resources.tempParent = tempParent;
  const workspaceRoot = createWorkspace(repositoryRoot, tempParent);
  resources.workspaceRoot = workspaceRoot;

  const markersPath = path.join(workspaceRoot, 'app-processes.log');
  const probeSource = path.join(workspaceRoot, 'src', `${probeName}.ts`);
  const probeOutput = path.join(workspaceRoot, 'dist', `${probeName}.js`);
  writeFileSync(probeSource, 'export const restartProbe = 1;\n');
  const env = createRuntimeEnvironment(workspaceRoot, markersPath);
  const tracker = startDev(workspaceRoot, env);
  resources.child = tracker.child;

  await waitFor(
    tracker,
    () => {
      const starts = appStarts(markersPath);
      return starts.length > 0 && tracker.ready.length > 0
        ? { start: starts[0], ready: tracker.ready[0] }
        : null;
    },
    'the initial application boot',
    120_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  if (!existsSync(probeOutput)) {
    throw new Error('Nest did not emit the restart probe JavaScript file.');
  }
  const oldOutput = readFileSync(probeOutput);
  const initialStartCount = appStarts(markersPath).length;
  const initialReadyCount = tracker.ready.length;
  const changeAt = performance.now();
  writeFileSync(probeSource, 'export const restartProbe = 2;\n');

  const compileEnd = await waitFor(
    tracker,
    () => {
      const output = readFileSync(probeOutput);
      return output.equals(oldOutput) ? null : performance.now();
    },
    'the changed probe JavaScript output',
  );
  const oldAppPid = appStarts(markersPath)[initialStartCount - 1].pid;
  const shutdownEnd = await waitFor(
    tracker,
    () => (!isProcessRunning(oldAppPid) ? performance.now() : null),
    'the old application process to stop',
  );
  const newStart = await waitFor(
    tracker,
    () => appStarts(markersPath)[initialStartCount] ?? null,
    'the replacement application process',
  );
  const ready = await waitFor(
    tracker,
    () => tracker.ready[initialReadyCount] ?? null,
    'the replacement application to listen again',
  );

  return {
    compile: compileEnd - changeAt,
    shutdown: shutdownEnd - compileEnd,
    boot: ready.epochMs - newStart.startedAt,
  };
}

/** @param {Record<string, number>} measurements @param {Baseline} baseline */
function report(measurements, baseline) {
  console.log(
    `Dev restart benchmark — baseline: ${path
      .relative(repositoryRoot, baselinePath)
      .replaceAll('\\', '/')}`,
  );
  console.log(`${baseline.name}; pnpm dev; PORT=0; no external services.`);
  const labels = {
    compile: 'compile (source edit to emitted JavaScript)',
    shutdown: 'process shutdown (emitted JavaScript to old PID exit)',
    boot: 'application boot (replacement PID to Nest ready)',
  };
  const results = comparePhases(measurements, baseline);
  for (const result of results) {
    console.log(
      `${labels[result.phase]}: ${Math.round(result.measuredMs)} ms ` +
        `(baseline ${result.baselineMs} ms, budget ${result.budgetMs} ms) ` +
        `${result.passed ? 'PASS' : 'FAIL'}`,
    );
  }
  return results.every((result) => result.passed);
}

async function main() {
  /** @param {'SIGINT' | 'SIGTERM'} signal */
  const onSignal = (signal) => {
    interruptSignal = signal;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const baseline = /** @type {Baseline} */ (
      JSON.parse(readFileSync(baselinePath, 'utf8'))
    );
    /** @type {Resources} */
    const resources = {};
    const measurements = await withBenchmarkCleanup(resources, () =>
      runMeasurement(resources),
    );
    if (!report(measurements, baseline)) process.exitCode = 1;
  } catch (error) {
    console.error(`Dev restart benchmark failed: ${error.message}`);
    process.exitCode =
      interruptSignal === 'SIGINT'
        ? 130
        : interruptSignal === 'SIGTERM'
          ? 143
          : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

if (path.resolve(process.argv[1] ?? '') === scriptPath) {
  void main();
}
