#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** @typedef {import('node:child_process').ChildProcess} ChildProcess */

const require = createRequire(import.meta.url);

/**
 * Configures the SWC native addon cache fallback on Windows when running
 * in restricted or virtualized profiles.
 */
export function ensureSwcBindingCache(cwd = process.cwd()) {
  if (process.platform === 'win32' && !process.env.SWC_NATIVE_BINDING_CACHE) {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData || !existsSync(path.join(localAppData, 'swc'))) {
      const tempCache = path.join(cwd, 'temp', 'swc-cache');
      try {
        mkdirSync(tempCache, { recursive: true });
        process.env.SWC_NATIVE_BINDING_CACHE = tempCache;
      } catch {
        // ignore cache directory initialization failure
      }
    }
  }
}

/**
 * Stops a child application process gracefully by sending an IPC shutdown
 * message (SIGTERM on POSIX only when the child has no IPC channel) and
 * awaiting exit before forcing termination.
 *
 * @param {ChildProcess | undefined} child
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{code: number | null, signal: NodeJS.Signals | null}>}
 */
export async function stopApp(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return {
      code: child?.exitCode ?? null,
      signal: child?.signalCode ?? null,
    };
  }

  /** @type {Promise<{code: number | null, signal: NodeJS.Signals | null}>} */
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const signalTerm = () => {
    if (process.platform === 'win32') return;
    try {
      child.kill('SIGTERM');
    } catch {
      // process may already have exited
    }
  };

  // A signal sent beside the message pre-empts the child's own shutdown path
  // (#1629), so SIGTERM is only the way in when IPC cannot carry the request.
  // ponytail: a connected child that ignores 'shutdown' waits for the SIGKILL
  // fallback below; add a SIGTERM grace period if such a child appears.
  if (child.connected) {
    try {
      child.send('shutdown', (error) => {
        if (error) signalTerm();
      });
    } catch {
      signalTerm();
    }
  } else {
    signalTerm();
  }

  const fallbackTimer = setTimeout(() => {
    try {
      child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
    } catch {
      // ignore process already gone
    }
  }, timeoutMs);
  fallbackTimer.unref?.();

  try {
    const result =
      /** @type {{code: number | null, signal: NodeJS.Signals | null}} */ (
        await exitPromise
      );
    return result;
  } finally {
    clearTimeout(fallbackTimer);
  }
}

/**
 * Runs the development server by separating incremental SWC compilation from
 * application execution. Restarts the application gracefully when outputs in
 * `dist/` change, without using `taskkill /T /F`.
 *
 * @param {{
 *   cwd?: string,
 *   entry?: string,
 *   sourceDir?: string,
 *   outDir?: string,
 *   args?: string[],
 *   debounceMs?: number,
 *   onRestart?: () => void,
 *   onAppSpawn?: (child: ChildProcess) => void,
 * }} [options]
 */
export function runDev(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const entry = options.entry ?? 'dist/main.js';
  const sourceDir = options.sourceDir ?? 'src';
  const outDir = options.outDir ?? 'dist';
  const appArgs = options.args ?? process.argv.slice(2);
  const debounceMs = options.debounceMs ?? 150;

  ensureSwcBindingCache(cwd);
  const pidFile = path.join(cwd, '.dev-runner.pid');
  try {
    writeFileSync(pidFile, String(process.pid));
  } catch {
    // ignore pid file write failure
  }

  const swcBin = require.resolve('@swc/cli/bin/swc.js');
  const swcArgs = [
    sourceDir,
    '-d',
    outDir,
    '--strip-leading-paths',
    '--ignore',
    '**/*.spec.ts,src/modules/*/testing/**',
    '-C',
    'module.type=commonjs',
  ];

  // Step 1: Initial one-shot compilation to ensure dist/ exists and is complete
  const initialCompile = spawnSync(process.execPath, [swcBin, ...swcArgs], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  if (initialCompile.status !== 0 && initialCompile.status !== null) {
    console.error(
      `[dev-runner] initial compilation failed with code ${initialCompile.status}`,
    );
  }

  // Step 2: Start SWC in incremental watch mode
  const swcWatcher = spawn(process.execPath, [swcBin, ...swcArgs, '-w'], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });

  /** @type {ChildProcess | undefined} */
  let currentChild;
  let restarting = false;
  let restartQueued = false;
  let shuttingDown = false;

  function spawnChild() {
    const child = spawn(
      process.execPath,
      ['--enable-source-maps', entry, ...appArgs],
      {
        cwd,
        env: process.env,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      },
    );
    child.on('exit', (code, signal) => {
      if (!shuttingDown && !restarting) {
        const reason = signal
          ? `terminated by ${signal}`
          : `exited with code ${code}`;
        console.log(
          `[dev-runner] application ${reason}. Waiting for file changes before restarting...`,
        );
      }
    });
    options.onAppSpawn?.(child);
    return child;
  }

  async function performRestart() {
    if (shuttingDown) return;
    if (restarting) {
      restartQueued = true;
      return;
    }
    restarting = true;
    try {
      if (currentChild) {
        await stopApp(currentChild);
        currentChild = undefined;
      }
      if (!shuttingDown) {
        options.onRestart?.();
        currentChild = spawnChild();
      }
    } finally {
      restarting = false;
      if (restartQueued && !shuttingDown) {
        restartQueued = false;
        void performRestart();
      }
    }
  }

  // Step 3: Start the application
  currentChild = spawnChild();

  // Step 4: Watch dist/ for compiled output changes
  /** @type {NodeJS.Timeout | undefined} */
  let restartTimer;
  const fullOutDir = path.resolve(cwd, outDir);
  const distWatcher = watch(
    fullOutDir,
    { recursive: true },
    (_event, filename) => {
      if (shuttingDown || !filename) return;
      const normalized = filename.toString().replace(/\\/g, '/');
      if (!/\.(?:[cm]?js|json)$/.test(normalized)) return;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        restartTimer = undefined;
        void performRestart();
      }, debounceMs);
    },
  );

  // Step 5: Clean shutdown on signal
  const parentMonitor = setInterval(() => {
    try {
      process.kill(process.ppid, 0);
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === 'ESRCH') {
        clearInterval(parentMonitor);
        void stopAll();
      }
    }
  }, 200);
  parentMonitor.unref?.();

  async function stopAll() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(parentMonitor);
    if (restartTimer) clearTimeout(restartTimer);
    try {
      rmSync(pidFile, { force: true });
    } catch {
      // ignore
    }
    try {
      distWatcher.close();
    } catch {
      // ignore
    }
    if (
      swcWatcher &&
      swcWatcher.exitCode === null &&
      swcWatcher.signalCode === null
    ) {
      try {
        swcWatcher.kill();
      } catch {
        // ignore
      }
    }
    if (currentChild) {
      await stopApp(currentChild);
      currentChild = undefined;
    }
  }

  return {
    stop: stopAll,
    restart: performRestart,
    get child() {
      return currentChild;
    },
    get swcWatcher() {
      return swcWatcher;
    },
  };
}

/** @param {string} moduleUrl @param {string | undefined} argv1 @returns {boolean} */
export function isEntryPoint(moduleUrl, argv1) {
  return Boolean(argv1) && moduleUrl === pathToFileURL(argv1).href;
}

async function main() {
  const runner = runDev();
  let terminating = false;
  /** @param {NodeJS.Signals} signal */
  const onSignal = async (signal) => {
    if (terminating) return;
    terminating = true;
    await runner.stop();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };

  process.once('SIGINT', () => void onSignal('SIGINT'));
  process.once('SIGTERM', () => void onSignal('SIGTERM'));
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  void main();
}
