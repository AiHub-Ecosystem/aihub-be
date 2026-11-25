import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Boots the built application (`dist/main.js`) as a child process with the
 * secret files the CI image boot renders, for specs that must see the real
 * startup path rather than a Nest test module.
 */

export const REPOSITORY_ROOT = resolve(__dirname, '../..');
export const BUILT_MAIN = join(REPOSITORY_ROOT, 'dist', 'main.js');

export interface BootEnvironment {
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
  /** Where the rendered runtime-secret bundle lives, so a spec can break it. */
  readonly runtimeSecretsFile: string;
}

export async function bootWithEnvironment(
  environment: NodeJS.ProcessEnv,
  workingDirectory: string,
): Promise<{ readonly child: ChildProcess; readonly logs: () => string }> {
  const child = spawn(process.execPath, [BUILT_MAIN], {
    cwd: workingDirectory,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => logs.push(chunk));
  }
  return { child, logs: () => logs.join('') };
}

export async function waitForChild(
  child: ChildProcess,
  predicate: () => boolean | Promise<boolean>,
  logs: () => string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Application exited early: ${logs()}`);
    }
    // real-timer-ok: the child process needs real startup and HTTP response time
    await delay(100);
  }
  throw new Error(`Timed out waiting for the application: ${logs()}`);
}

/** Resolves once the child exits, with its exit code, or fails at the bound. */
export async function waitForExit(
  child: ChildProcess,
  logs: () => string,
): Promise<number | null> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return child.exitCode;
    }
    // real-timer-ok: the child process needs real startup time to reject its configuration
    await delay(100);
  }
  throw new Error(`The application did not exit: ${logs()}`);
}

export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) =>
    child.once('exit', () => resolvePromise()),
  );
  child.kill('SIGKILL');
  await exited;
}

export async function withBootEnvironment<T>(
  operation: (boot: BootEnvironment) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'aihub-built-app-'));
  try {
    const generated = join(directory, 'ci-boot');
    mkdirSync(generated);
    execFileSync(
      process.execPath,
      [join(REPOSITORY_ROOT, 'scripts/ci/boot/ci-boot-config.cjs'), generated],
      { cwd: REPOSITORY_ROOT },
    );
    const runtimeSecretsFile = join(generated, 'runtime-secrets.json');
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...Object.fromEntries(
        readFileSync(join(generated, 'boot.env'), 'utf8')
          .split(/\r?\n/)
          .filter((line) => line !== '' && !line.startsWith('#'))
          .map((line) => {
            const separator = line.indexOf('=');
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      ),
      NODE_ENV: 'development',
      PORT: '0',
      AIHUB_LISTEN_SOCKET: '',
      AIHUB_RUNTIME_SECRETS_FILE: runtimeSecretsFile,
      AIHUB_AUTH_MFA_SECRETS_FILE: join(generated, 'auth-mfa-secrets.json'),
      AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: join(
        generated,
        'connection-secrets.json',
      ),
      AIHUB_EMAIL_WAL_SECRETS_FILE: join(generated, 'email-wal-secrets.json'),
    };
    return await operation({ directory, environment, runtimeSecretsFile });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
