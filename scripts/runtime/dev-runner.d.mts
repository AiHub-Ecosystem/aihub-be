import type { ChildProcess } from 'node:child_process';

export interface DevRunnerController {
  readonly stop: () => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly child: ChildProcess | undefined;
  readonly swcWatcher: ChildProcess | undefined;
}

export interface DevRunnerOptions {
  readonly cwd?: string;
  readonly entry?: string;
  readonly sourceDir?: string;
  readonly outDir?: string;
  readonly args?: string[];
  readonly debounceMs?: number;
  readonly onRestart?: () => void;
  readonly onAppSpawn?: (child: ChildProcess) => void;
}

export interface StopAppResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export function ensureSwcBindingCache(cwd?: string): void;
export function stopApp(
  child?: ChildProcess,
  timeoutMs?: number,
): Promise<StopAppResult>;
export function runDev(options?: DevRunnerOptions): DevRunnerController;
export function isEntryPoint(
  moduleUrl: string,
  argv1: string | undefined,
): boolean;
