import { execFile } from 'node:child_process';

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['scripts/cli/cli.mjs', ...args],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '' } },
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

function recentDays(): readonly [string, string] {
  const day = 24 * 60 * 60 * 1000;
  const iso = (offset: number) =>
    new Date(Date.now() + offset * day).toISOString().slice(0, 10);
  return [iso(-7), iso(0)];
}

// The first spawn of the CLI in a run loads the whole runtime and can pass the
// default five seconds on a busy machine.
jest.setTimeout(30_000);

describe('usage:major-report CLI', () => {
  it('rejects a malformed window before opening infrastructure', async () => {
    const result = await runCli([
      'usage:major-report',
      '--from',
      '2026-10-01T00:00:00Z',
      '--to',
      '2026-10-02',
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
  });

  it('emits a safe configuration failure for a valid window', async () => {
    const [from, to] = recentDays();
    const result = await runCli([
      'usage:major-report',
      '--from',
      from,
      '--to',
      to,
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"event":"public_api_major_report_failed"');
    expect(result.stdout).toContain(
      '"error_code":"PUBLIC_API_MAJOR_REPORT_CONFIGURATION_MISSING"',
    );
    expect(result.stdout).not.toContain('DATABASE_URL');
  });

  it('rejects unsupported operator overrides', async () => {
    const [from, to] = recentDays();
    const result = await runCli([
      'usage:major-report',
      '--from',
      from,
      '--to',
      to,
      '--database-url',
      'postgres://secret',
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
  });
});
