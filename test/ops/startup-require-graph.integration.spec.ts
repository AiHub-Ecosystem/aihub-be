import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { useTestRuntimeConfiguration } from '../support/test-runtime-configuration';

const REPOSITORY_ROOT = resolve(__dirname, '../..');
const MAIN = join(REPOSITORY_ROOT, 'dist', 'main.js');

interface LoadedModules {
  readonly openApi: string[];
  readonly total: number;
}

interface ProbeResult {
  readonly health: number;
  readonly docs: number;
  readonly before: LoadedModules;
  readonly after: LoadedModules;
}

async function bootWithEnvironment(
  environment: NodeJS.ProcessEnv,
  workingDirectory: string,
): Promise<{ readonly child: ChildProcess; readonly logs: () => string }> {
  const child = spawn(process.execPath, [MAIN], {
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

async function waitForChild(
  child: ChildProcess,
  predicate: () => boolean | Promise<boolean>,
  logs: () => string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Application exited early: ${logs()}`);
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for the application: ${logs()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) =>
    child.once('exit', () => resolvePromise()),
  );
  child.kill('SIGKILL');
  await exited;
}

async function withBootEnvironment<T>(
  operation: (directory: string, environment: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'aihub-startup-graph-'));
  try {
    const generated = join(directory, 'ci-boot');
    mkdirSync(generated);
    execFileSync(
      process.execPath,
      [join(REPOSITORY_ROOT, 'scripts/ci/boot/ci-boot-config.cjs'), generated],
      { cwd: REPOSITORY_ROOT },
    );
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
      AIHUB_RUNTIME_SECRETS_FILE: join(generated, 'runtime-secrets.json'),
      AIHUB_AUTH_MFA_SECRETS_FILE: join(generated, 'auth-mfa-secrets.json'),
      AIHUB_RUNTIME_CONNECTION_SECRETS_FILE: join(
        generated,
        'connection-secrets.json',
      ),
      AIHUB_EMAIL_WAL_SECRETS_FILE: join(generated, 'email-wal-secrets.json'),
    };
    return await operation(directory, environment);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function runProbe(
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly result: ProbeResult | undefined }> {
  const resultFile = join(directory, 'probe.json');
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      join(REPOSITORY_ROOT, 'test/fixtures/startup-require-graph-probe.ts'),
      resultFile,
    ],
    { cwd: REPOSITORY_ROOT, env: environment, encoding: 'utf8' },
  );
  const result: ProbeResult | undefined = existsSync(resultFile)
    ? (JSON.parse(readFileSync(resultFile, 'utf8')) as ProbeResult)
    : undefined;
  return { result };
}

const withBuild = existsSync(MAIN) ? describe : describe.skip;

withBuild('startup require graph (#227)', () => {
  beforeAll(() => {
    useTestRuntimeConfiguration();
  });

  it('does not load OpenAPI document modules until a documentation route needs them', async () => {
    await withBootEnvironment(async (directory, environment) => {
      const { result } = await runProbe(directory, environment);
      expect(result).toBeDefined();
      expect(result?.docs).toBe(200);
      expect(result?.before.openApi).toEqual([]);
      expect(result?.after.openApi.length).toBeGreaterThan(0);
      expect(result?.after.total).toBeGreaterThan(result?.before.total ?? 0);
    });
  }, 60_000);

  it('reports a malformed local environment file as a configuration error at boot', async () => {
    await withBootEnvironment(async (directory, environment) => {
      writeFileSync(
        join(directory, '.env'),
        'THIS LINE HAS NO EQUALS SIGN\nPORT=not-a-port\n',
      );
      const { child, logs } = await bootWithEnvironment(environment, directory);
      try {
        await waitForChild(
          child,
          () => child.exitCode !== null || child.signalCode !== null,
          logs,
        );
        const output = logs();
        expect(output).toContain('Nest configuration error');
        expect(output).toContain('.env');
        expect(output).not.toContain('Unhandled');
      } finally {
        await stopChild(child);
      }
    });
  });
});
