import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const SOURCE_FILE = /\.(?:m|c)?(?:ts|js)$/i;
const TYPESCRIPT_FILE = /\.(?:m|c)?ts$/i;
const JAVASCRIPT_FILE = /\.(?:m|c)?js$/i;

/** @param {string} output */
export function parseStagedPaths(output) {
  return output.split('\0').filter(Boolean);
}

/**
 * Builds the environment passed to spawned check commands. #1894: unsets keys
 * explicitly passed as undefined (such as REDIS_URL and DATABASE_URL for Jest)
 * so unit tests do not inherit live service connection strings from .env or shell.
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildStagedCommandEnv(options) {
  const env = { ...process.env, GOMAXPROCS: '1' };
  if (options?.env) {
    for (const [key, val] of Object.entries(options.env)) {
      if (val === undefined) {
        delete env[key];
      } else {
        env[key] = val;
      }
    }
  }
  return env;
}

/** @param {string} command @param {string[]} args @param {{ env?: Record<string, string | undefined> }} [options] */
function runCommand(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: buildStagedCommandEnv(options),
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`${command} failed: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

/** @typedef {(command: string, args: string[], options?: { env?: Record<string, string | undefined> }) => number} CommandRunner */
/** @param {{ stagedFiles: string[], runCommand?: CommandRunner }} options */
export function runStagedChecks({ stagedFiles, runCommand: run = runCommand }) {
  if (stagedFiles.length === 0) return 0;

  const sourceFiles = stagedFiles.filter((file) => SOURCE_FILE.test(file));
  const typescriptFiles = sourceFiles.filter((file) =>
    TYPESCRIPT_FILE.test(file),
  );
  const javascriptFiles = sourceFiles.filter((file) =>
    JAVASCRIPT_FILE.test(file),
  );
  let exitCode = 0;

  if (typescriptFiles.length > 0) {
    exitCode = run(process.execPath, [
      'lint',
      '--no-script',
      '--type-aware',
      '--threads=1',
      '--format=unix',
      '--tsconfig',
      'tsconfig.json',
      ...typescriptFiles,
    ]);
    if (exitCode !== 0) return exitCode;
  }

  if (javascriptFiles.length > 0) {
    // shortcut: Staged JavaScript checks only floating promises; broaden after type-aware JS parity is verified.
    exitCode = run(process.execPath, [
      'lint',
      '--no-script',
      '--type-aware',
      '--threads=1',
      '-A',
      'all',
      '-D',
      'typescript/no-floating-promises',
      '--format=unix',
      ...javascriptFiles,
    ]);
    if (exitCode !== 0) return exitCode;
  }

  if (sourceFiles.length > 0) {
    // #1894: Bun auto-loads .env at startup, injecting dev services (REDIS_URL,
    // DATABASE_URL) into process.env. When Jest inherits REDIS_URL, AppModule in
    // HTTP/auth integration suites instantiates live Redis connections that hang
    // during app.close() in afterAll and exceed the 5s hook timeout. Strip
    // connection strings to keep the staged unit lane hermetic.
    exitCode = run(
      process.execPath,
      [
        'x',
        'jest',
        '--findRelatedTests',
        '--coverage=false',
        '--passWithNoTests',
        '--runInBand',
        ...sourceFiles,
      ],
      {
        env: {
          REDIS_URL: undefined,
          DATABASE_URL: undefined,
        },
      },
    );
  }

  return exitCode;
}

function main() {
  const staged = spawnSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );

  if (staged.error || staged.status !== 0) {
    console.error(
      staged.error?.message ?? staged.stderr ?? 'git diff --cached failed',
    );
    return 1;
  }

  return runStagedChecks({ stagedFiles: parseStagedPaths(staged.stdout) });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main();
}
