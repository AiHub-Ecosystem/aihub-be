import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: '' },
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['scripts/cli.mjs', ...args],
      { cwd: process.cwd(), env },
      (error, stdout, stderr) => {
        const code = error?.code;
        resolve({
          status: typeof code === 'number' ? code : error === null ? 0 : 1,
          stdout,
          stderr,
        });
      },
    );
  });
}

function recentWindow(): readonly [string, string] {
  const to = new Date(Date.now() - 60_000);
  to.setUTCMilliseconds(0);
  const from = new Date(to.getTime() - 3_600_000);
  return [from.toISOString(), to.toISOString()];
}

describe('usage report CLI', () => {
  it('ships the generic loader and no obsolete command loaders', async () => {
    const [dockerfile, dockerignore] = await Promise.all([
      readFile('Dockerfile', 'utf8'),
      readFile('.dockerignore', 'utf8'),
    ]);
    const obsoleteLoaders = [
      'organization-status.cjs',
      'organization-first-owner.cjs',
      'usage-prune.cjs',
      'usage-report.cjs',
      'quota-reconcile.cjs',
    ];

    expect(dockerfile).toContain('/app/scripts/load-cli-runner.cjs');
    expect(dockerignore).toContain('!scripts/load-cli-runner.cjs');
    for (const loader of obsoleteLoaders) {
      expect(dockerfile).not.toContain(`/app/scripts/${loader}`);
      expect(dockerignore).not.toContain(`!scripts/${loader}`);
    }
  });

  it('rejects malformed UTC arguments before opening infrastructure', async () => {
    const result = await runCli([
      'usage:report',
      '--from',
      '2026-09-20T12:00:00+01:00',
      '--to',
      '2026-09-20T13:00:00.000Z',
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Command failed');
  });

  it('emits a safe configuration failure for a valid window', async () => {
    const [from, to] = recentWindow();
    const result = await runCli(['usage:report', '--from', from, '--to', to]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"event":"usage_report_failed"');
    expect(result.stdout).toContain(
      '"error_code":"USAGE_REPORT_CONFIGURATION_MISSING"',
    );
    expect(result.stdout).not.toContain('DATABASE_URL');
    expect(result.stderr).toContain('Command failed');
  });

  it('rejects unsupported operator overrides', async () => {
    const [from, to] = recentWindow();
    const result = await runCli([
      'usage:report',
      '--from',
      from,
      '--to',
      to,
      '--database-url',
      'postgres://secret',
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Command failed');
  });
});
