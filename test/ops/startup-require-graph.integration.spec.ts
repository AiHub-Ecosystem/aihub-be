import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BUILT_MAIN,
  REPOSITORY_ROOT,
  bootWithEnvironment,
  stopChild,
  waitForChild,
  withBootEnvironment,
} from '../support/built-app-boot';
import { useTestRuntimeConfiguration } from '../support/test-runtime-configuration';

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

const withBuild = existsSync(BUILT_MAIN) ? describe : describe.skip;

withBuild('startup require graph (#227)', () => {
  beforeAll(() => {
    useTestRuntimeConfiguration();
  });

  it('does not load OpenAPI document modules until a documentation route needs them', async () => {
    await withBootEnvironment(async ({ directory, environment }) => {
      const { result } = await runProbe(directory, environment);
      expect(result).toBeDefined();
      expect(result?.docs).toBe(200);
      expect(result?.before.openApi).toEqual([]);
      expect(result?.after.openApi.length).toBeGreaterThan(0);
      expect(result?.after.total).toBeGreaterThan(result?.before.total ?? 0);
    });
  }, 60_000);

  it('reports a malformed local environment file as a configuration error at boot', async () => {
    // real-timer-ok: the test waits for an OS child process to reject startup configuration
    await withBootEnvironment(async ({ directory, environment }) => {
      writeFileSync(
        join(directory, '.env'),
        'THIS LINE HAS NO EQUALS SIGN\nPORT=not-a-port\n',
      );
      const { child, logs } = await bootWithEnvironment(environment, directory);
      try {
        // real-timer-ok: the child process needs real startup and HTTP response time
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
